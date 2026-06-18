/**
 * v2.5 — Desktop ↔ core LLM fallback integration test.
 *
 * Exercises the chain:
 *
 *   SettingsPanel → .gitwandrc → useGitWand.loadRealFiles → resolveAsync → core
 *
 * without mounting any Vue component. We mock the I/O layer (`backend.ts`)
 * and the AI provider (`useAIProvider`) so the composable's `openPath()`
 * pulls a deterministic conflict, a deterministic `.gitwandrc`, and a
 * deterministic LLM endpoint — and we then assert on the resulting
 * `MergeResult.decisions[0].trace.llmTrace`.
 *
 * Two scenarios:
 *
 *   1. Happy path : endpoint returns a valid resolution → `llm_proposed`
 *      with `validationScore >= 80` and a populated `LlmTrace`.
 *   2. Rejection path : endpoint returns code with residual conflict
 *      markers → validation score = 0 → resolution refused → hunk stays
 *      `llm_proposed` but `autoResolved: false`, `llmTrace.accepted: false`.
 *
 * The point of the test is to prove the wiring works — not to re-validate
 * the core (the core has its own suite under `packages/core/src/__tests__/`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmEndpoint } from "@gitwand/core";

// ─── Mock the backend (Tauri / dev-server) ─────────────────────
// We mock the whole `backend.ts` module so `loadRealFiles()` can read
// fixture content without touching the filesystem or Rust commands.

const mockReadGitwandrc = vi.fn<(cwd: string) => Promise<string>>();
const mockGetConflictedFiles = vi.fn<(cwd: string) => Promise<string[]>>();
const mockReadFile = vi.fn<(cwd: string, path: string) => Promise<string>>();

vi.mock("../utils/backend", () => ({
  pickFolder: vi.fn(),
  getConflictedFiles: (cwd: string) => mockGetConflictedFiles(cwd),
  readFile: (cwd: string, path: string) => mockReadFile(cwd, path),
  writeFile: vi.fn(),
  readGitwandrc: (cwd: string) => mockReadGitwandrc(cwd),
  // Tree conflicts not exercised in this suite — return empty list.
  getTreeConflicts: vi.fn().mockResolvedValue([]),
  resolveTreeConflict: vi.fn(),
  // Markerless reconstruction — return empty content (no markers) so the
  // normal conflict flow proceeds unaffected in these LLM-focused tests.
  reconstructConflict: vi.fn().mockResolvedValue({ content: "", wtMatchesSide: false }),
  gitStage: vi.fn(),
  // Stubs the composable also references transitively (folder history, etc.).
  isTauri: () => false,
}));

// ─── Mock useAIProvider so we control the LlmEndpoint ──────────
const mockEndpointCall = vi.fn<(prompt: string) => Promise<string>>();
const mockToLlmEndpoint = vi.fn<() => LlmEndpoint | null>(() => ({
  call: (prompt: string) => mockEndpointCall(prompt),
}));

vi.mock("../composables/useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: { value: true },
    isLoading: { value: false },
    lastError: { value: null },
    lastSuggestion: { value: null },
    suggest: vi.fn(),
    rawPrompt: vi.fn(),
    toLlmEndpoint: mockToLlmEndpoint,
  }),
}));

// Mock the folder-history composable: it touches localStorage and we don't
// need its behaviour in this test.
vi.mock("../composables/useFolderHistory", () => ({
  useFolderHistory: () => ({
    history: { value: [] },
    addToHistory: vi.fn(),
    removeFromHistory: vi.fn(),
    clearHistory: vi.fn(),
  }),
}));

// i18n is read for the "provider missing" warning toast — return the key
// verbatim so the test doesn't depend on a real locale being loaded.
vi.mock("../composables/useI18n", () => ({
  t: (key: string) => key,
  useI18n: () => ({ t: (key: string) => key }),
}));

// ─── Test setup helpers ─────────────────────────────────────────
import { useGitWand } from "../composables/useGitWand";

const REPO_PATH = "/tmp/fake-repo";
// `.txt` so the resolver skips both the structural (tree-sitter) merge —
// which would try to fetch grammar WASM and fail in Node test env — and
// every format-aware resolver (JSON/Markdown/YAML/…). The conflict then
// flows straight to the pattern classifier and lands on `complex` /
// `llm_proposed` as we want.
const CONFLICT_PATH = "src/config.txt";

/** A conflict that the deterministic engine classifies as `complex`. */
const TS_CONFLICT = [
  `export const config = {`,
  `<<<<<<< ours`,
  `  level: "warn",`,
  `  format: "json",`,
  `  ttl: 60,`,
  `||||||| base`,
  `  level: "info",`,
  `  format: "text",`,
  `=======`,
  `  level: "error",`,
  `  format: "logfmt",`,
  `  retries: 3,`,
  `>>>>>>> theirs`,
  `};`,
].join("\n");

const GITWANDRC = JSON.stringify({
  llmFallback: {
    enabled: true,
    model: "claude-sonnet-4-6",
    contextLines: 50,
    minPostMergeScore: 80,
    minMode: "strict",
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default wiring — happy path. Individual tests override mockEndpointCall.
  mockReadGitwandrc.mockResolvedValue(GITWANDRC);
  mockGetConflictedFiles.mockResolvedValue([CONFLICT_PATH]);
  mockReadFile.mockResolvedValue(TS_CONFLICT);
  mockToLlmEndpoint.mockReturnValue({
    call: (prompt: string) => mockEndpointCall(prompt),
  });
});

// ─── Tests ─────────────────────────────────────────────────────

describe("desktop ↔ core LLM fallback integration", () => {
  it("happy path: LLM resolves the complex hunk, decision carries an LlmTrace", async () => {
    mockEndpointCall.mockResolvedValue(
      [
        "```",
        `  level: "warn",`,
        `  format: "json",`,
        `  ttl: 60,`,
        `  retries: 3,`,
        "```",
      ].join("\n"),
    );

    const gw = useGitWand();
    await gw.openPath(REPO_PATH);

    // backend.ts contracts honoured ?
    expect(mockReadGitwandrc).toHaveBeenCalledWith(REPO_PATH);
    expect(mockGetConflictedFiles).toHaveBeenCalledWith(REPO_PATH);
    expect(mockReadFile).toHaveBeenCalledWith(REPO_PATH, CONFLICT_PATH);

    // useAIProvider was consulted because `.gitwandrc.llmFallback.enabled` is true.
    expect(mockToLlmEndpoint).toHaveBeenCalled();
    expect(mockEndpointCall).toHaveBeenCalledTimes(1);

    // Composable surfaces the resolved file.
    expect(gw.files.value).toHaveLength(1);
    const f = gw.files.value[0];
    expect(f.path).toBe(CONFLICT_PATH);

    // Core produced a fully-resolved mergedContent (no remaining markers).
    expect(f.result.mergedContent).not.toBeNull();
    expect(f.result.mergedContent).not.toContain("<<<<<<<");
    expect(f.result.mergedContent).toContain(`level: "warn"`);
    expect(f.result.mergedContent).toContain(`retries: 3`);

    // The decision (HunkResolution) is `llm_proposed` and carries a full LlmTrace.
    const hunk = f.result.hunks[0];
    const resolution = f.result.resolutions[0];
    expect(hunk.type).toBe("llm_proposed");
    expect(resolution.autoResolved).toBe(true);

    const trace = hunk.trace.llmTrace;
    expect(trace).toBeDefined();
    expect(trace!.accepted).toBe(true);
    expect(trace!.model).toBe("claude-sonnet-4-6");
    expect(trace!.validationScore).toBeGreaterThanOrEqual(80);
    expect(trace!.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejection path: invalid resolution → hunk stays unresolved, trace records the refusal", async () => {
    // Return a "code" snippet that still contains residual conflict markers.
    // `validateMergedContent` flags it → validationScore = 0 → pipeline refuses.
    mockEndpointCall.mockResolvedValue(
      [
        "```",
        `<<<<<<< ours`,
        `  level: "warn",`,
        `>>>>>>> theirs`,
        "```",
      ].join("\n"),
    );

    const gw = useGitWand();
    await gw.openPath(REPO_PATH);

    expect(mockEndpointCall).toHaveBeenCalledTimes(1);

    const f = gw.files.value[0];
    const hunk = f.result.hunks[0];
    const resolution = f.result.resolutions[0];

    // Pipeline refused → hunk type stays llm_proposed (classification stays
    // even when resolution fails), autoResolved is false, mergedContent null.
    expect(hunk.type).toBe("llm_proposed");
    expect(resolution.autoResolved).toBe(false);
    expect(f.result.mergedContent).toBeNull();

    // Audit trail still attached so the UI can show the rejection reason.
    const trace = hunk.trace.llmTrace;
    expect(trace).toBeDefined();
    expect(trace!.accepted).toBe(false);
    expect(trace!.validationScore).toBeLessThan(80);
  });

  it("disabled fallback: when `.gitwandrc.llmFallback.enabled` is false, no endpoint is called", async () => {
    mockReadGitwandrc.mockResolvedValue(
      JSON.stringify({ llmFallback: { enabled: false } }),
    );
    // Even if the endpoint mock would respond, we expect it not to be called.
    mockEndpointCall.mockResolvedValue("```\nshould not run\n```");

    const gw = useGitWand();
    await gw.openPath(REPO_PATH);

    expect(mockEndpointCall).not.toHaveBeenCalled();

    const f = gw.files.value[0];
    expect(f.result.hunks[0].type).toBe("complex");
    expect(f.result.resolutions[0].autoResolved).toBe(false);
    expect(f.result.hunks[0].trace.llmTrace).toBeUndefined();
  });

  it("missing provider: enabled in .gitwandrc but `toLlmEndpoint()` returns null → fallback skipped, no crash", async () => {
    // Simulate the AI provider being un-configured (no API key, "none" selected, etc.)
    mockToLlmEndpoint.mockReturnValue(null);

    const gw = useGitWand();
    await gw.openPath(REPO_PATH);

    // The endpoint was never consulted (it's null), so no call.
    expect(mockEndpointCall).not.toHaveBeenCalled();

    // The composable surfaces the "provider missing" warning via the shared
    // error ref (toast). The hunk remains classified as `complex` because
    // `setLlmFallbackEnabled(true)` is gated on `endpoint` being present.
    expect(gw.error.value).toBeTruthy();
    const f = gw.files.value[0];
    expect(f.result.hunks[0].type).toBe("complex");
    expect(f.result.resolutions[0].autoResolved).toBe(false);
  });
});

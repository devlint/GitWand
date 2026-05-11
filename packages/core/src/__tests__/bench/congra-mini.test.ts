/**
 * v2.5 — ConGra-mini regression bench.
 *
 * Loads ~15 hand-crafted `complex` conflicts under
 * `__tests__/fixtures/congra-mini/`, feeds each to `resolveAsync()` with the
 * LLM fallback enabled and a deterministic mock endpoint, then tallies the
 * resolution outcome.
 *
 * ## Done criterion (CORE-V2-ROADMAP v2.5)
 *
 * > "résout au moins 80 % des hunks `complex` du ConGra-mini sans régression
 * > sur le reste"
 *
 * The test fails if `successRate < 0.80`. We do NOT lower the threshold when
 * a fixture regresses — that's the whole point of locking the bench. If a
 * fixture becomes unrealistic for the deterministic+LLM pipeline, either
 * fix the pipeline or replace the fixture; do not move the goalposts.
 *
 * ## Why `validationLevel: "off"`
 *
 * Tree-sitter grammars are not loaded in unit tests (the bench runs without
 * `web-tree-sitter` peer or grammar WASMs). Parse-tree validation would
 * therefore always return `null` and is irrelevant to what we're measuring
 * here — namely, the LLM fallback's hit rate.
 *
 * ## Why a normal `describe` and not Vitest's `bench`
 *
 * We are measuring a hit rate, not throughput. A real bench (`bench(...)`)
 * would re-run the same workload many times and report ops/s — useless here.
 * The file is named `*.bench.ts` to keep it co-located with the other
 * regression-style benches, but it lives in the standard test suite so CI
 * runs it on every push.
 *
 * Use `SKIP_BENCH=true pnpm test` to skip the suite in fast iterations.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAsync } from "../../resolver/index.js";
import { buildMockEndpoint, fenced } from "../utils/mock-llm-endpoint.js";

// ─── Fixture loader ──────────────────────────────────────

interface FixtureMeta {
  filePath: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  category: "ts" | "python" | "go" | "rust" | "json" | "markdown";
}

interface Fixture {
  name: string;
  conflict: string;
  expectedResolution: string;
  meta: FixtureMeta;
  /** Unique key for the mock endpoint — the ours-block lines (first conflict). */
  oursSnippet: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "..", "fixtures", "congra-mini");

/**
 * Extract a unique substring of the first conflict's `ours` block. We grab
 * the first non-empty line after `<<<<<<< ours` — that's enough to
 * disambiguate fixtures whose conflict markers are unique per fixture.
 */
function extractOursSnippet(conflict: string): string {
  const lines = conflict.split("\n");
  const start = lines.findIndex((l) => l.startsWith("<<<<<<<"));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && (l.startsWith("|||||||") || l.startsWith("=======")));
  const ours = lines.slice(start + 1, end === -1 ? lines.length : end);
  return ours.find((l) => l.trim().length > 0) ?? ours.join("\n");
}

function loadFixtures(): Fixture[] {
  const entries = readdirSync(FIXTURES_ROOT).filter((n) => {
    const p = join(FIXTURES_ROOT, n);
    return statSync(p).isDirectory();
  });

  return entries.sort().map((name) => {
    const dir = join(FIXTURES_ROOT, name);
    const conflict = readFileSync(join(dir, "conflict.txt"), "utf-8");
    const expectedResolution = readFileSync(
      join(dir, "expected-llm-resolution.txt"),
      "utf-8",
    );
    const meta = JSON.parse(
      readFileSync(join(dir, "meta.json"), "utf-8"),
    ) as FixtureMeta;
    return {
      name,
      conflict,
      expectedResolution,
      meta,
      oursSnippet: extractOursSnippet(conflict),
    };
  });
}

// ─── Tally helpers ───────────────────────────────────────

type Outcome = "llm-resolved" | "deterministic-resolved" | "unresolved";

interface FixtureResult {
  fixture: Fixture;
  outcome: Outcome;
  decisionType: string;
  validationScore?: number;
  reason: string;
}

function classifyOutcome(
  fixture: Fixture,
  result: Awaited<ReturnType<typeof resolveAsync>>,
): FixtureResult {
  const firstHunk = result.hunks[0];
  const firstResolution = result.resolutions[0];

  if (!firstHunk || !firstResolution) {
    return {
      fixture,
      outcome: "unresolved",
      decisionType: "no-hunk",
      reason: "no conflict parsed",
    };
  }

  // Resolved by the LLM fallback → success.
  if (firstHunk.type === "llm_proposed" && firstResolution.autoResolved) {
    return {
      fixture,
      outcome: "llm-resolved",
      decisionType: firstHunk.type,
      validationScore: firstHunk.trace.llmTrace?.validationScore,
      reason: firstResolution.resolutionReason,
    };
  }

  // Resolved by a deterministic pattern before the LLM ran → does NOT count
  // toward LLM success (the fixture was supposed to be `complex`).
  if (firstResolution.autoResolved) {
    return {
      fixture,
      outcome: "deterministic-resolved",
      decisionType: firstHunk.type,
      reason: firstResolution.resolutionReason,
    };
  }

  return {
    fixture,
    outcome: "unresolved",
    decisionType: firstHunk.type,
    validationScore: firstHunk.trace.llmTrace?.validationScore,
    reason: firstResolution.resolutionReason,
  };
}

// ─── Suite ───────────────────────────────────────────────

const SKIP = process.env.SKIP_BENCH === "true";

describe.skipIf(SKIP)("ConGra-mini — LLM fallback regression bench", () => {
  const fixtures = loadFixtures();

  it("loads exactly 15 fixtures", () => {
    expect(fixtures.length).toBe(15);
  });

  it("each fixture parses one or more conflict hunks", () => {
    for (const f of fixtures) {
      expect(f.conflict).toContain("<<<<<<<");
      expect(f.conflict).toContain("=======");
      expect(f.conflict).toContain(">>>>>>>");
      expect(f.oursSnippet.length).toBeGreaterThan(0);
    }
  });

  it("resolves ≥ 80 % of complex hunks via the LLM fallback", async () => {
    // Build a single mock endpoint that knows every fixture's expected
    // resolution. The endpoint matches by ours-snippet substring (see
    // mock-llm-endpoint.ts).
    const responses = new Map<string, string>();
    for (const f of fixtures) {
      responses.set(f.oursSnippet, fenced(f.expectedResolution));
    }
    const endpoint = buildMockEndpoint(responses);

    const results: FixtureResult[] = [];

    for (const f of fixtures) {
      const merge = await resolveAsync(f.conflict, f.meta.filePath, {
        llmFallback: {
          enabled: true,
          endpoint,
          minPostMergeScore: 80,
          contextLines: 50,
        },
        // Tree-sitter is unavailable in unit-test env — disable parse-tree
        // validation. The LLM resolver still runs `validateMergedContent`
        // (residual markers + JSON/YAML/TOML syntax).
        validationLevel: "off",
      });
      results.push(classifyOutcome(f, merge));
    }

    // Per-fixture log (one line each) + summary.
    const lines: string[] = [];
    for (const r of results) {
      const symbol =
        r.outcome === "llm-resolved" ? "✓"
        : r.outcome === "deterministic-resolved" ? "·"
        : "✗";
      const score = r.validationScore !== undefined ? ` score=${r.validationScore}` : "";
      lines.push(
        `  ${symbol} [${r.fixture.meta.category}/${r.fixture.meta.difficulty}] ${r.fixture.name} → ${r.decisionType}${score}`,
      );
    }

    const llmResolved = results.filter((r) => r.outcome === "llm-resolved").length;
    const deterministic = results.filter((r) => r.outcome === "deterministic-resolved").length;
    const unresolved = results.filter((r) => r.outcome === "unresolved").length;
    const total = results.length;
    const successRate = llmResolved / total;

    const summary = [
      "",
      "ConGra-mini bench summary:",
      ...lines,
      "",
      `  Total fixtures        : ${total}`,
      `  LLM-resolved          : ${llmResolved} (${(successRate * 100).toFixed(1)} %)`,
      `  Deterministic-resolved: ${deterministic} (regressions — expected to be complex)`,
      `  Unresolved            : ${unresolved}`,
      `  Target                : ≥ 80 % LLM-resolved`,
      "",
    ].join("\n");

    // eslint-disable-next-line no-console
    console.log(summary);

    expect(
      successRate,
      `LLM fallback resolved ${llmResolved}/${total} = ${(successRate * 100).toFixed(1)} % (target ≥ 80 %).\n${summary}`,
    ).toBeGreaterThanOrEqual(0.8);
  });
});

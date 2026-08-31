/**
 * Tests du pattern llm_proposed (v2.5) et de la pipeline LLM fallback.
 *
 * Couvre :
 * 1. Comportement du PatternPlugin (flag module-level, confidence, priority)
 * 2. tryLlmFallbackResolve (endpoint mock, parsing, validation, trace)
 * 3. Intégration resolveAsync avec mock endpoint déterministe
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import llmProposed, {
  setLlmFallbackEnabled,
  isLlmFallbackEnabled,
} from "../../patterns/llm-proposed.js";
import { tryLlmFallbackResolve } from "../../resolvers/llm-fallback.js";
import { resolveAsync } from "../../resolver/index.js";
import type { ClassifyInput, LlmEndpoint } from "../../types.js";

// ─── Helpers ──────────────────────────────────────────────────

/** Hunk fictif minimal pour les tests unitaires du pattern */
const SIMPLE_HUNK: ClassifyInput = {
  oursLines: ["  level: 'warn',", "  format: 'json',"],
  baseLines: ["  level: 'info',", "  format: 'text',"],
  theirsLines: ["  level: 'error',", "  format: 'logfmt',"],
  startLine: 10,
  endLine: 20,
};

/** Conflit diff3 simple pour les tests d'intégration */
const COMPLEX_DIFF3 = [
  `<<<<<<< ours`,
  `  level: "warn",`,
  `  format: "json",`,
  `||||||| base`,
  `  level: "info",`,
  `  format: "text",`,
  `=======`,
  `  level: "error",`,
  `  format: "logfmt",`,
  `>>>>>>> theirs`,
].join("\n");

/** Endpoint mock déterministe — retourne toujours une résolution valide */
function makeMockEndpoint(responseText: string): LlmEndpoint {
  return {
    async call(_prompt: string): Promise<string> {
      return responseText;
    },
  };
}

// ─── 1. PatternPlugin unit tests ──────────────────────────────

describe("llm_proposed PatternPlugin — métadonnées", () => {
  it("a le bon type", () => {
    expect(llmProposed.type).toBe("llm_proposed");
  });

  it("a la bonne priorité (998, juste avant complex 999)", () => {
    expect(llmProposed.priority).toBe(998);
  });

  it("requires === 'both' (évalué quelle que soit la disponibilité de la base)", () => {
    expect(llmProposed.requires).toBe("both");
  });
});

describe("llm_proposed PatternPlugin — flag module-level", () => {
  afterEach(() => {
    // Toujours réinitialiser le flag après chaque test
    setLlmFallbackEnabled(false);
  });

  it("detect() retourne false par défaut (LLM désactivé)", () => {
    expect(llmProposed.detect(SIMPLE_HUNK)).toBe(false);
  });

  it("isLlmFallbackEnabled() retourne false par défaut", () => {
    expect(isLlmFallbackEnabled()).toBe(false);
  });

  it("detect() retourne true après setLlmFallbackEnabled(true)", () => {
    setLlmFallbackEnabled(true);
    expect(llmProposed.detect(SIMPLE_HUNK)).toBe(true);
  });

  it("detect() retourne false après reset setLlmFallbackEnabled(false)", () => {
    setLlmFallbackEnabled(true);
    setLlmFallbackEnabled(false);
    expect(llmProposed.detect(SIMPLE_HUNK)).toBe(false);
  });
});

describe("llm_proposed PatternPlugin — confidence", () => {
  it("typeClassification = 50 (incertitude LLM)", () => {
    const score = llmProposed.confidence(SIMPLE_HUNK);
    expect(score.dimensions.typeClassification).toBe(50);
  });

  it("dataRisk = 60 (risque d'hallucination)", () => {
    const score = llmProposed.confidence(SIMPLE_HUNK);
    expect(score.dimensions.dataRisk).toBe(60);
  });

  it("score composite trop bas pour auto-résolution (label low ou medium)", () => {
    const score = llmProposed.confidence(SIMPLE_HUNK);
    // score = 50 - 60*0.40 = 50 - 24 = 26 → "low"
    expect(score.label).toBe("low");
    expect(score.score).toBeLessThan(44);
  });

  it("penalties liste les risques LLM", () => {
    const score = llmProposed.confidence(SIMPLE_HUNK);
    expect(score.penalties.length).toBeGreaterThan(0);
    expect(score.penalties.some((p) => p.toLowerCase().includes("llm") || p.toLowerCase().includes("deterministic"))).toBe(true);
  });
});

// ─── 2. tryLlmFallbackResolve ─────────────────────────────────

describe("tryLlmFallbackResolve — sans endpoint", () => {
  it("retourne lines: null quand endpoint absent", async () => {
    const hunk = {
      ...SIMPLE_HUNK,
      type: "llm_proposed" as const,
      confidence: llmProposed.confidence(SIMPLE_HUNK),
      explanation: llmProposed.explanation(SIMPLE_HUNK),
      trace: {
        steps: [],
        selected: "llm_proposed" as const,
        summary: "test",
        hasBase: true,
      },
      zdiff3: false,
    };

    const result = await tryLlmFallbackResolve(
      hunk,
      "src/config.ts",
      "// contexte fictif",
      { enabled: true }, // pas d'endpoint
    );

    expect(result.lines).toBeNull();
    expect(result.llmTrace.accepted).toBe(false);
    expect(result.reason).toMatch(/endpoint/i);
  });
});

describe("tryLlmFallbackResolve — endpoint mock", () => {
  const MOCK_HUNK = {
    oursLines: [`  level: "warn",`, `  format: "json",`],
    baseLines: [`  level: "info",`, `  format: "text",`],
    theirsLines: [`  level: "error",`, `  format: "logfmt",`],
    startLine: 10,
    endLine: 20,
    type: "llm_proposed" as const,
    confidence: llmProposed.confidence(SIMPLE_HUNK),
    explanation: llmProposed.explanation(SIMPLE_HUNK),
    trace: {
      steps: [],
      selected: "llm_proposed" as const,
      summary: "LLM fallback activé",
      hasBase: true,
    },
    zdiff3: false,
  };

  it("extrait les lignes d'un bloc fencé valide", async () => {
    const endpoint = makeMockEndpoint(
      "```\n  level: \"warn\",\n  format: \"json\",\n```",
    );
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(result.lines).not.toBeNull();
    expect(result.lines).toEqual([`  level: "warn",`, `  format: "json",`]);
    expect(result.llmTrace.accepted).toBe(true);
  });

  it("retourne lines: null pour CANNOT_RESOLVE", async () => {
    const endpoint = makeMockEndpoint("CANNOT_RESOLVE");
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(result.lines).toBeNull();
    expect(result.llmTrace.accepted).toBe(false);
    expect(result.reason).toMatch(/cannot_resolve|refusé/i);
  });

  it("retourne lines: null quand l'endpoint throw une erreur", async () => {
    const endpoint: LlmEndpoint = {
      async call() { throw new Error("network timeout"); },
    };
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(result.lines).toBeNull();
    expect(result.llmTrace.accepted).toBe(false);
    expect(result.reason).toMatch(/erreur|network timeout/i);
  });

  it("LlmTrace — promptHash est un hash hexadécimal non-vide (FNV-1a, 16 chars)", async () => {
    const endpoint = makeMockEndpoint("```\n  level: \"warn\",\n```");
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(result.llmTrace.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("LlmTrace — rawResponseTruncated est ≤ 500 chars", async () => {
    const longResponse = "x".repeat(1000);
    const endpoint = makeMockEndpoint(longResponse);
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(result.llmTrace.rawResponseTruncated.length).toBeLessThanOrEqual(500);
  });

  it("LlmTrace — calledAt est un ISO 8601 valide", async () => {
    const endpoint = makeMockEndpoint("```\n  level: \"warn\",\n```");
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(() => new Date(result.llmTrace.calledAt)).not.toThrow();
    expect(new Date(result.llmTrace.calledAt).toISOString()).toBe(result.llmTrace.calledAt);
  });

  it("LlmTrace — model par défaut est claude-sonnet-4-6", async () => {
    const endpoint = makeMockEndpoint("```\n  level: \"warn\",\n```");
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
    });

    expect(result.llmTrace.model).toBe("claude-sonnet-4-6");
  });

  it("refus si validationScore < minPostMergeScore (marqueurs résiduels)", async () => {
    // Endpoint qui retourne des marqueurs de conflit résiduels
    const endpoint = makeMockEndpoint(
      "```\n<<<<<<< ours\n  bad content\n>>>>>>> theirs\n```",
    );
    const result = await tryLlmFallbackResolve(MOCK_HUNK, "src/config.ts", "", {
      enabled: true,
      endpoint,
      minPostMergeScore: 80,
    });

    expect(result.lines).toBeNull();
    expect(result.llmTrace.validationScore).toBe(0);
    expect(result.llmTrace.accepted).toBe(false);
  });
});

// ─── 3. resolveAsync — intégration LLM fallback ───────────────

describe("resolveAsync — sans llmFallback", () => {
  it("un hunk complex reste complex et non résolu", async () => {
    const result = await resolveAsync(COMPLEX_DIFF3, "src/config.ts");
    expect(result.hunks[0].type).toBe("complex");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.mergedContent).toBeNull();
  });
});

describe("resolveAsync — avec llmFallback enabled sans endpoint", () => {
  it("le hunk reste complex quand l'endpoint est absent (flag LLM non activé)", async () => {
    // Sans endpoint, llmEnabled = false → setLlmFallbackEnabled jamais appelé
    // → classification normale → "complex"
    const result = await resolveAsync(COMPLEX_DIFF3, "src/config.ts", {
      llmFallback: { enabled: true }, // enabled mais pas d'endpoint → llmEnabled = false
    });
    expect(result.hunks[0].type).toBe("complex");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.mergedContent).toBeNull();
  });
});

describe("resolveAsync — avec llmFallback enabled et endpoint mock", () => {
  // Note : on utilise validationLevel: "off" pour éviter la validation parse-tree
  // sur des contenus partiels (lignes de code hors d'un fichier complet).
  // En production, l'appelant fournit un fichier complet qui parse correctement.

  it("résout le hunk complex via LLM, mergedContent non null", async () => {
    const resolvedLines = `  level: "warn",\n  format: "json",`;
    const endpoint = makeMockEndpoint(`\`\`\`\n${resolvedLines}\n\`\`\``);

    const result = await resolveAsync(COMPLEX_DIFF3, "src/config.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
    });

    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).not.toBeNull();
    expect(result.hunks[0].type).toBe("llm_proposed");
  });

  it("la DecisionTrace contient llmTrace quand résolu par LLM", async () => {
    const resolvedLines = `  level: "warn",\n  format: "json",`;
    const endpoint = makeMockEndpoint(`\`\`\`\n${resolvedLines}\n\`\`\``);

    const result = await resolveAsync(COMPLEX_DIFF3, "src/config.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
    });

    const hunk = result.resolutions[0].hunk;
    expect(hunk.trace.llmTrace).toBeDefined();
    expect(hunk.trace.llmTrace!.accepted).toBe(true);
    expect(hunk.trace.llmTrace!.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reste non résolu si l'endpoint retourne CANNOT_RESOLVE", async () => {
    const endpoint = makeMockEndpoint("CANNOT_RESOLVE");

    const result = await resolveAsync(COMPLEX_DIFF3, "src/config.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
    });

    expect(result.stats.autoResolved).toBe(0);
    expect(result.mergedContent).toBeNull();
    // La trace LLM est quand même attachée pour l'audit
    expect(result.resolutions[0].hunk.trace.llmTrace).toBeDefined();
    expect(result.resolutions[0].hunk.trace.llmTrace!.accepted).toBe(false);
  });

  it("les hunks déjà résolus (non-complex) ne sont pas re-classifiés llm_proposed", async () => {
    // Conflit trivial + conflit complexe
    const mixedInput = [
      `<<<<<<< ours`,
      `const x = 1;`,
      `||||||| base`,
      `const x = 1;`,
      `=======`,
      `const x = 1;`,
      `>>>>>>> theirs`,
      `some text`,
      `<<<<<<< ours`,
      `  level: "warn",`,
      `||||||| base`,
      `  level: "info",`,
      `=======`,
      `  level: "error",`,
      `>>>>>>> theirs`,
    ].join("\n");

    const endpoint = makeMockEndpoint("```\n  level: \"warn\",\n```");
    const result = await resolveAsync(mixedInput, "src/config.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
    });

    // Premier hunk : same_change, auto-résolu par le moteur déterministe
    expect(result.hunks[0].type).toBe("same_change");
    // Deuxième hunk : llm_proposed, résolu via LLM
    expect(result.hunks[1].type).toBe("llm_proposed");
  });
});

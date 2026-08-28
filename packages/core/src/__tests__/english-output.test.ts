/**
 * Guard: every string the engine hands to a consumer is written in English.
 *
 * The engine's explanations, resolution reasons, decision traces, boosters and
 * penalties are not internal debug text. They reach users through the desktop
 * merge editor, the CLI summary, the MCP server's `explanation` and
 * `resolutionReason` fields, and the WebMCP tools on the website, none of which
 * translate them. They were French until they were translated wholesale, which
 * meant every non-French user read French.
 *
 * This test asserts the property on real engine output rather than by scanning
 * the source, so it cannot be fooled by how a string is assembled. It catches
 * accented French, which is how most of it reads; the accent-free residue
 * ("Confiance medium ... insuffisante ...") is why the word list exists too.
 *
 * Comments and test names in this repository are deliberately French. This
 * guard is only about what leaves the engine.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "../resolver/index.js";
import { CORPUS } from "./corpus.js";

const ACCENTED = /[éèêëàâçùûôîïœÉÈÊÀÇÙÔÎ]/;
const FRENCH_WORDS =
  /\b(Confiance|insuffisante?|requis|politique|Résolution|Fusion|conflit|conflits|fichier|lignes?|bloc|côtés?|réussie|aucune?|impossible|manquante?)\b/i;

/** Every user-visible string a single resolve() call produces. */
function outputStrings(conflicted: string, filePath: string, options = {}): string[] {
  const result = resolve(conflicted, filePath, options);
  const out: string[] = [];
  for (const r of result.resolutions) {
    out.push(r.resolutionReason, r.hunk.explanation, r.hunk.trace.summary);
    out.push(...r.hunk.trace.steps.map((s) => s.reason));
    out.push(...r.hunk.confidence.boosters, ...r.hunk.confidence.penalties);
  }
  if (result.validation.syntaxError) out.push(result.validation.syntaxError);
  return out.filter((s): s is string => typeof s === "string" && s.length > 0);
}

describe("engine output is English", () => {
  it.each(CORPUS.map((f) => [f.id, f] as const))(
    "%s produces no French output",
    (_id, fixture) => {
      const offenders = outputStrings(fixture.input, fixture.filePath, fixture.options ?? {})
        .filter((s) => ACCENTED.test(s) || FRENCH_WORDS.test(s));

      expect(offenders).toEqual([]);
    },
  );

  it("the guard actually detects French, so a green run means something", () => {
    // Without this, a bug that made outputStrings() return [] would leave every
    // case above passing vacuously.
    expect(ACCENTED.test("résolution triviale")).toBe(true);
    expect(FRENCH_WORDS.test("Confiance medium insuffisante")).toBe(true);
    expect(ACCENTED.test("Same edit on both sides")).toBe(false);
    expect(FRENCH_WORDS.test("Same edit on both sides")).toBe(false);
  });

  it("reads a non-empty set of strings out of a real resolution", () => {
    const strings = outputStrings(CORPUS[0].input, CORPUS[0].filePath, CORPUS[0].options ?? {});
    expect(strings.length).toBeGreaterThan(3);
  });
});

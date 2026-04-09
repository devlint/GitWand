/**
 * GitWand — Benchmarks de performance (Phase 7.5)
 *
 * Mesure le temps de résolution sur des fichiers de taille variable.
 * Lancé avec : `pnpm test:bench` ou `npx vitest bench`
 *
 * Scénarios :
 * - small  : 1 conflit, ~15 lignes
 * - medium : 5 conflits, ~120 lignes
 * - large  : 20 conflits, ~500 lignes
 * - huge   : 50 conflits, ~1200 lignes (simule un lockfile)
 */

import { describe, bench } from "vitest";
import { resolve } from "../resolver.js";

// ─── Générateurs de contenu ───────────────────────────────

/**
 * Génère un bloc de texte TypeScript neutre (pas de conflit).
 */
function makeNeutralTs(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(`const value${i} = compute(${i}, ${i * 2});`);
  }
  return lines.join("\n");
}

/**
 * Génère un conflit de type same_change (trivial, résolution certaine).
 */
function makeSameChangeConflict(index: number): string {
  return [
    `<<<<<<< ours`,
    `function handler${index}(req: Request): Response {`,
    `  const data = process(req.body);`,
    `  return json({ data, status: "ok" });`,
    `}`,
    `||||||| base`,
    `function handler${index}(req: Request): Response {`,
    `  return json({ data: req.body });`,
    `}`,
    `=======`,
    `function handler${index}(req: Request): Response {`,
    `  const data = process(req.body);`,
    `  return json({ data, status: "ok" });`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n");
}

/**
 * Génère un conflit non_overlapping (structurel, résolution haute confiance).
 */
function makeNonOverlappingConflict(index: number): string {
  return [
    `<<<<<<< ours`,
    `import { feature${index}A } from "./features";`,
    `import { shared } from "./shared";`,
    `||||||| base`,
    `import { shared } from "./shared";`,
    `=======`,
    `import { shared } from "./shared";`,
    `import { feature${index}B } from "./features";`,
    `>>>>>>> theirs`,
  ].join("\n");
}

/**
 * Génère un fichier complet avec N conflits entourés de texte neutre.
 */
function makeFile(conflictCount: number, neutralLinesPerConflict: number): string {
  const parts: string[] = [];
  for (let i = 0; i < conflictCount; i++) {
    // Texte neutre avant
    parts.push(makeNeutralTs(neutralLinesPerConflict));
    // Conflit alternant entre same_change et non_overlapping
    parts.push(i % 2 === 0 ? makeSameChangeConflict(i) : makeNonOverlappingConflict(i));
  }
  // Texte final
  parts.push(makeNeutralTs(neutralLinesPerConflict));
  return parts.join("\n");
}

// ─── Fixtures ────────────────────────────────────────────

const SMALL  = makeFile(1,   8);   // ~30  lignes
const MEDIUM = makeFile(5,   15);  // ~140 lignes
const LARGE  = makeFile(20,  20);  // ~530 lignes
const HUGE   = makeFile(50,  15);  // ~1350 lignes

// ─── Benchmarks ───────────────────────────────────────────

describe("resolve() — benchmarks de performance", () => {
  bench("small  (1 conflit  / ~30 lignes)",   () => {
    resolve(SMALL,  "src/handlers.ts");
  });

  bench("medium (5 conflits / ~140 lignes)",  () => {
    resolve(MEDIUM, "src/handlers.ts");
  });

  bench("large  (20 conflits / ~530 lignes)", () => {
    resolve(LARGE,  "src/handlers.ts");
  });

  bench("huge   (50 conflits / ~1350 lignes)", () => {
    resolve(HUGE,   "src/handlers.ts");
  });

  bench("JSON sémantique (config.json)", () => {
    const jsonConflict = [
      `<<<<<<< ours`,
      `{ "name": "app", "version": "1.0.0", "debug": true, "port": 3000 }`,
      `||||||| base`,
      `{ "name": "app", "version": "1.0.0", "port": 3000 }`,
      `=======`,
      `{ "name": "app", "version": "1.0.0", "logLevel": "warn", "port": 3000 }`,
      `>>>>>>> theirs`,
    ].join("\n");
    resolve(jsonConflict, "config.json");
  });

  bench("Markdown section-aware (README.md)", () => {
    const mdConflict = [
      `<<<<<<< ours`,
      `# My App`,
      ``,
      `## Installation`,
      ``,
      `Run \`npm install\`.`,
      ``,
      `## Usage`,
      ``,
      `Import and use.`,
      `=======`,
      `# My App`,
      ``,
      `## Installation`,
      ``,
      `Run \`npm install\`.`,
      ``,
      `## Contributing`,
      ``,
      `Open a PR.`,
      `>>>>>>> theirs`,
    ].join("\n");
    resolve(mdConflict, "README.md");
  });
});

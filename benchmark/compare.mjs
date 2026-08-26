#!/usr/bin/env node
/**
 * benchmark/compare.mjs — le garde-fou du lot G.
 *
 * Compare un run frais à la baseline commitée et échoue (exit 1) si le moteur
 * a régressé au-delà du bruit. Les seuils encodent la leçon des lots C/E/F :
 * l'ACCORD est la métrique protégée (une baisse = le moteur se trompe plus),
 * la COUVERTURE peut baisser volontairement (décliner ce qui était appliqué à
 * tort est un progrès) mais pas s'effondrer en silence.
 *
 *   node benchmark/compare.mjs results/v2-baseline.json results/ci.json
 */

import { readFileSync } from "node:fs";

// Bruit toléré : l'accord par dépôt varie de ±1-2 pts entre runs identiques
// (fichiers limites, ordre de fs). Au-delà, c'est un vrai mouvement.
const MAX_AGREEMENT_DROP_TOTAL = 1.5;   // points de % sur l'agrégat
const MAX_AGREEMENT_DROP_REPO = 5;      // points de % sur un dépôt
const MAX_COVERAGE_DROP_RATIO = 0.25;   // -25 % de fichiers résolus e2e max sans justification

const [baselinePath, freshPath] = process.argv.slice(2);
if (!baselinePath || !freshPath) {
  console.error("usage: node benchmark/compare.mjs <baseline.json> <fresh.json>");
  process.exit(2);
}
const base = JSON.parse(readFileSync(baselinePath, "utf-8"));
const fresh = JSON.parse(readFileSync(freshPath, "utf-8"));

const failures = [];
const notes = [];

const agree = (r) => (r.headline.agreementExactShare ?? null);
const files = (r) => r.headline.agreementComparableFiles ?? 0;

// ── agrégat ────────────────────────────────────────────────
const aBase = agree(base);
const aFresh = agree(fresh);
if (aBase !== null && aFresh !== null) {
  const delta = aFresh - aBase;
  (delta < -MAX_AGREEMENT_DROP_TOTAL ? failures : notes).push(
    `agreement (corpus): ${aBase}% → ${aFresh}% (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pts)`,
  );
}
{
  const fBase = files(base);
  const fFresh = files(fresh);
  if (fBase > 0 && fFresh < fBase * (1 - MAX_COVERAGE_DROP_RATIO)) {
    failures.push(`coverage collapsed: ${fBase} → ${fFresh} files resolved end-to-end (>-25%). A deliberate decline policy must update the baseline in the same PR, with the reasoning in the commit message.`);
  } else {
    notes.push(`coverage: ${fBase} → ${fFresh} files resolved end-to-end`);
  }
}

// ── par dépôt ──────────────────────────────────────────────
const baseByRepo = new Map(base.perRepo.filter((r) => !r.error).map((r) => [r.repo, r]));
for (const r of fresh.perRepo) {
  if (r.error) { failures.push(`${r.repo}: run failed — ${r.error}`); continue; }
  const b = baseByRepo.get(r.repo);
  if (!b) { notes.push(`${r.repo}: new in corpus, no baseline`); continue; }
  const ba = b.agreement?.exactShare;
  const fa = r.agreement?.exactShare;
  if (ba != null && fa != null) {
    const delta = fa - ba;
    (delta < -MAX_AGREEMENT_DROP_REPO ? failures : notes).push(
      `${r.repo}: ${ba}% → ${fa}% (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts, ${r.agreement.comparable} files)`,
    );
  }
}

console.log("═══ benchmark gate ═══");
for (const n of notes) console.log("  ·", n);
if (failures.length) {
  console.log("\n✗ REGRESSIONS:");
  for (const f of failures) console.log("  ✗", f);
  process.exit(1);
}
console.log("\n✓ no regression beyond noise");

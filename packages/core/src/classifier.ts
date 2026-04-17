/**
 * GitWand — Classifier (Pattern Registry)
 *
 * Remplace l'implémentation monolithique de classifyConflict() dans parser.ts.
 * Chaque pattern est un PatternPlugin isolé dans src/patterns/.
 * Le classifier itère les patterns triés par priorité et retourne le premier match.
 *
 * v1.4 : registre pluggable — ajouter un pattern = créer un fichier + l'inscrire ici.
 */

import type { ClassifyInput, ClassifyResult, ConflictType, PatternPlugin, TraceStep, DecisionTrace } from "./types.js";

// ─── Imports des patterns ─────────────────────────────────────

import sameChange          from "./patterns/same-change.js";
import deleteNoChange      from "./patterns/delete-no-change.js";
import oneSideChange       from "./patterns/one-side-change.js";
import nonOverlapping      from "./patterns/non-overlapping.js";
import whitespaceOnly      from "./patterns/whitespace-only.js";
import reorderOnly              from "./patterns/reorder-only.js";
import insertionAtBoundary      from "./patterns/insertion-at-boundary.js";
import valueOnlyChange          from "./patterns/value-only-change.js";
import complex             from "./patterns/complex.js";

// ─── Registre ────────────────────────────────────────────────

/**
 * Registre ordonné des patterns.
 * L'ordre dans ce tableau n'a pas d'importance — le tri se fait par `priority`.
 * Pour ajouter un pattern : importer le plugin et l'ajouter ici.
 */
const PATTERNS: PatternPlugin[] = [
  sameChange,           // priority 10
  deleteNoChange,       // priority 20
  oneSideChange,        // priority 30
  nonOverlapping,       // priority 40
  whitespaceOnly,       // priority 50
  reorderOnly,          // priority 55  ← v1.4
  insertionAtBoundary,  // priority 57  ← v1.4
  valueOnlyChange,      // priority 60
  complex,              // priority 999 (fallback — detect() always true)
];

// ─── Trace builder ───────────────────────────────────────────

/**
 * Construit la DecisionTrace en rejouant tous les patterns éligibles.
 * Les patterns non éligibles (filtrés par `requires`) sont ajoutés
 * avec une raison standard "requires diff3/diff2, sauté".
 *
 * @param h        - Le hunk classifié
 * @param eligible - Patterns éligibles (filtrés + triés)
 * @param all      - Tous les patterns du registre (triés)
 * @param matched  - Le pattern qui a matché
 */
function buildTrace(
  h: ClassifyInput,
  eligible: PatternPlugin[],
  all: PatternPlugin[],
  matched: PatternPlugin,
): DecisionTrace {
  const hasBase = h.baseLines.length > 0;
  const steps: TraceStep[] = [];

  for (const pattern of all) {
    const isEligible = eligible.includes(pattern);

    if (!isEligible) {
      // Pattern sauté à cause du filtre `requires`
      const skipReason = pattern.requires === "diff3"
        ? `Base (diff3) indisponible — ${pattern.type} requiert diff3, sauté.`
        : `Base présente — ${pattern.type} requiert diff2 (sans base), sauté.`;
      steps.push({ type: pattern.type, passed: false, reason: skipReason });
      continue;
    }

    if (pattern === matched) {
      steps.push({ type: pattern.type, passed: true, reason: pattern.passReason(h) });
      break; // On s'arrête au premier match
    }

    steps.push({ type: pattern.type, passed: false, reason: pattern.failReason(h) });
  }

  return {
    steps,
    selected: matched.type,
    summary: buildSummary(matched.type, h),
    hasBase,
  };
}

function buildSummary(type: ConflictType, h: ClassifyInput): string {
  const hasBase = h.baseLines.length > 0;
  switch (type) {
    case "same_change":          return "Même modification des deux côtés → résolution triviale.";
    case "delete_no_change":     return hasBase
      ? (h.oursLines.length === 0 ? "Ours a supprimé ce bloc, theirs est resté identique à la base." : "Theirs a supprimé ce bloc, ours est resté identique à la base.")
      : (h.oursLines.length === 0 ? "Ours a supprimé ce bloc (diff2 — sans base, confiance moyenne)." : "Theirs a supprimé ce bloc (diff2 — sans base, confiance moyenne).");
    case "one_side_change":      return h.oursLines.join("\n") === h.baseLines.join("\n")
      ? "Seul theirs a modifié ce bloc — résolution : accepter theirs."
      : "Seul ours a modifié ce bloc — résolution : accepter ours.";
    case "non_overlapping":      return "Modifications non-overlapping — fusion automatique par LCS 3-way.";
    case "whitespace_only":      return "Même code, whitespace différent — résolution : préférer ours.";
    case "reorder_only":         return "Mêmes lignes, ordre différent — résolution : accepter l'ordre theirs.";
    case "insertion_at_boundary": return "Insertions pures des deux côtés — résolution par union.";
    case "value_only_change":    return "Même structure, valeur(s) volatile(s) différente(s) — résolution : accepter theirs.";
    case "complex":              return "Conflit complexe — toutes les heuristiques automatiques ont échoué.";
    default:                     return `Type détecté : ${type}.`;
  }
}

// ─── classifyConflict ─────────────────────────────────────────

/**
 * Classifie un hunk de conflit en itérant sur le registre de patterns.
 *
 * Remplace l'implémentation monolithique de parser.ts (v1.3).
 * Le comportement observable est identique — seule l'organisation interne change.
 *
 * @param hunk - Le hunk brut extrait par parseConflictMarkers()
 * @returns ClassifyResult avec type, confidence, explanation et trace
 */
export function classifyConflict(hunk: ClassifyInput): ClassifyResult {
  const hasBase = hunk.baseLines.length > 0;

  // Filtrer par `requires` + trier par priorité
  const eligible = PATTERNS
    .filter((p) =>
      p.requires === "both" ||
      (p.requires === "diff3" && hasBase) ||
      (p.requires === "diff2" && !hasBase),
    )
    .sort((a, b) => a.priority - b.priority);

  // Trier tous les patterns pour la trace (ordre global)
  const allSorted = [...PATTERNS].sort((a, b) => a.priority - b.priority);

  for (const pattern of eligible) {
    if (pattern.detect(hunk)) {
      const trace = buildTrace(hunk, eligible, allSorted, pattern);
      return {
        type: pattern.type,
        confidence: pattern.confidence(hunk),
        explanation: pattern.explanation(hunk),
        trace,
      };
    }
  }

  // Unreachable — complex.detect() always returns true
  throw new Error("[GitWand] classifyConflict: aucun pattern n'a matché (complex manquant ?)");
}

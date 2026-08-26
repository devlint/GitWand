/**
 * Post-merge validation (Phase 7.2).
 *
 * Vérifie que le contenu fusionné ne laisse pas de marqueurs de conflit
 * résiduels et, pour les formats structurés (JSON/JSONC, YAML, TOML),
 * qu'il reste syntaxiquement valide. Extrait de `resolver.ts` lors du
 * split P1.1, puis étendu YAML/TOML en P2.5.
 */

import * as YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import type { ValidationResult } from "../types.js";

/** Patterns de marqueurs de conflit résiduels. */
export const RESIDUAL_MARKER_PATTERNS = [
  /^<{7}\s/,  // <<<<<<< ours
  /^>{7}\s/,  // >>>>>>> theirs
  /^\|{7}\s/, // ||||||| base
  /^={7}$/,   // =======
];

/**
 * Format structuré reconnu pour la validation syntaxique post-merge.
 * `null` = format non reconnu → pas de validation syntaxique.
 */
type StructuredFormat = "json" | "yaml" | "toml" | null;

/** Détecte le format structuré à partir de l'extension du fichier. */
function detectFormat(filePath: string): StructuredFormat {
  if (/\.json(c)?$/i.test(filePath)) return "json";
  if (/\.ya?ml$/i.test(filePath)) return "yaml";
  if (/\.toml$/i.test(filePath)) return "toml";
  return null;
}

/**
 * Parse le contenu selon le format détecté. Retourne `null` si OK,
 * sinon un message d'erreur préfixé par le format (ex: "YAML: ...").
 *
 * Le préfixe permet de savoir quel parser a échoué sans avoir à
 * enrichir le type `ValidationResult` — `syntaxError: string | null`
 * reste le contrat public.
 */
function tryParse(content: string, format: StructuredFormat): string | null {
  if (format === null) return null;
  try {
    switch (format) {
      case "json":
        JSON.parse(content);
        return null;
      case "yaml":
        // `yaml.parse` échoue dur sur les erreurs de syntaxe (vs `parseDocument`
        // qui les accumule). On veut un fail-fast équivalent à JSON.parse.
        YAML.parse(content);
        return null;
      case "toml":
        parseToml(content);
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${format.toUpperCase()}: ${msg}`;
  }
}

// ─── accuracy lot 1 — Invariants de format ──────────────────────────────────────────────
//
// La validation syntaxique ne suffit pas : un changelog avec deux sections
// « ## [Unreleased] » parse très bien, un package.json avec une clé dupliquée
// aussi (JSON.parse garde silencieusement la dernière). Ces invariants-là sont
// exactement ce qu'une fusion textuelle casse. Une violation entraîne la
// rétractation des résolutions du fichier (voir resolver/index.ts).

/**
 * Détecte les clés dupliquées dans un document JSON, objet par objet.
 * Scanner tolérant : suit l'imbrication et l'état « dans une chaîne »
 * (échappements compris) sans construire d'AST. `.json` strict uniquement —
 * les commentaires JSONC feraient mentir le suivi de chaînes.
 */
export function findDuplicateJsonKeys(content: string): string[] {
  const duplicates: string[] = [];
  type Frame = { type: "obj" | "arr"; keys: Set<string>; expectKey: boolean };
  const stack: Frame[] = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i];

    if (ch === '"') {
      // Lire la chaîne entière (échappements compris)
      let j = i + 1;
      let str = "";
      while (j < n) {
        const c = content[j];
        if (c === "\\") { str += content[j + 1] ?? ""; j += 2; continue; }
        if (c === '"') break;
        str += c;
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (top?.type === "obj" && top.expectKey) {
        if (top.keys.has(str) && !duplicates.includes(str)) duplicates.push(str);
        top.keys.add(str);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }

    if (ch === "{") stack.push({ type: "obj", keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ type: "arr", keys: new Set(), expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.type === "obj") top.expectKey = true;
    }
    i += 1;
  }
  return duplicates;
}

/** Un fichier est « de type changelog » si son nom de base commence par changelog/history/releases et finit en .md. */
function isChangelogFile(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  return /^(changelog|history|releases|release-notes)\b.*\.(md|markdown)$/i.test(base);
}

/**
 * Vérifie les invariants du format au-delà de la syntaxe.
 * Retourne la liste (possiblement vide) des violations, en clair.
 */
export function checkFormatInvariants(content: string, filePath: string): string[] {
  const violations: string[] = [];

  if (isChangelogFile(filePath)) {
    const lines = content.split("\n");
    const unreleased = lines.filter((l) => /^##\s+\[?unreleased/i.test(l.trim()));
    if (unreleased.length > 1) {
      violations.push(`Changelog : ${unreleased.length} sections « Unreleased » — un changelog n'en a qu'une.`);
    }
    const headings = lines.map((l) => l.trim()).filter((l) => /^##\s+\[?v?\d/i.test(l));
    const seen = new Set<string>();
    for (const h of headings) {
      if (seen.has(h)) { violations.push(`Changelog : section de version dupliquée — « ${h.slice(0, 80)} ».`); break; }
      seen.add(h);
    }
  }

  if (/\.json$/i.test(filePath)) {
    const dup = findDuplicateJsonKeys(content);
    if (dup.length > 0) {
      violations.push(`JSON : clé(s) dupliquée(s) dans un même objet — ${dup.slice(0, 5).map((k) => `« ${k} »`).join(", ")}. JSON.parse garderait silencieusement la dernière.`);
    }
  }

  return violations;
}

/**
 * Valide le contenu fusionné pour détecter les problèmes résiduels.
 *
 * Vérifie :
 * 1. Marqueurs de conflit résiduels (indique une résolution incomplète)
 * 2. Erreurs de syntaxe pour les formats structurés :
 *    - JSON/JSONC (`.json`, `.jsonc`)
 *    - YAML       (`.yaml`, `.yml`)
 *    - TOML       (`.toml`)
 *
 * @param content - Contenu fusionné à valider
 * @param filePath - Chemin du fichier (pour détecter le type)
 */
export function validateMergedContent(content: string, filePath: string): ValidationResult {
  // 1. Détection de marqueurs résiduels
  const lines = content.split("\n");
  const residualMarkerLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RESIDUAL_MARKER_PATTERNS.some((p) => p.test(line))) {
      residualMarkerLines.push(i + 1); // 1-indexed
    }
  }

  const hasResidualMarkers = residualMarkerLines.length > 0;

  // 2. Validation syntaxique pour formats structurés
  const format = detectFormat(filePath);
  const syntaxError = tryParse(content, format);

  // 3. accuracy lot 1 — Invariants de format (au-delà de la syntaxe)
  const invariantErrors = checkFormatInvariants(content, filePath);

  const isValid = !hasResidualMarkers && syntaxError === null && invariantErrors.length === 0;

  // parseTreeValid est null ici car validateMergedContent est synchrone.
  // La validation parse-tree (tree-sitter, async) est effectuée séparément
  // dans resolveAsync() via checkParseTreeValid().
  return {
    hasResidualMarkers,
    residualMarkerLines,
    syntaxError,
    isValid,
    invariantErrors,
    parseTreeValid: null,
    parseTreeErrors: 0,
    parseTreeErrorRanges: [],
  };
}

/** Validation vide (pour les cas où le contenu n'est pas encore fusionné). */
export const EMPTY_VALIDATION: ValidationResult = {
  hasResidualMarkers: false,
  residualMarkerLines: [],
  syntaxError: null,
  isValid: true,
  invariantErrors: [],
  parseTreeValid: null,
  parseTreeErrors: 0,
  parseTreeErrorRanges: [],
};

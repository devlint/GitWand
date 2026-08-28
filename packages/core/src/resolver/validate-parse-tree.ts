/**
 * @gitwand/core v2.4 — Parse-tree validation
 *
 * Vérifie si le contenu fusionné produit un arbre syntaxique sans erreurs
 * via web-tree-sitter. Utilisé comme couche de filet de sécurité après
 * la résolution automatique : si le merge produit du code syntaxiquement
 * cassé, les résolutions sont rétractées pour revenir aux marqueurs de conflit.
 *
 * Contrainte : cette fonction est async (tree-sitter est lazy-loaded).
 * Elle retourne `null` (graceful) si :
 *   - web-tree-sitter n'est pas installé
 *   - Le fichier n'est pas d'un langage supporté (TS/JS/Python/Go/Rust)
 *   - Le chargement de la grammaire échoue
 *
 * Elle ne lève jamais d'exception — les erreurs sont silencieusement absorbées.
 */

import { isStructuralLanguage } from "../structural/parsers/grammars/languages.js";
import { loadGrammarForFile } from "../structural/parsers/grammars/ts.js";
import { createParser } from "../structural/parsers/loader.js";
import { hasParseErrors } from "../structural/entities.js";
import type { LoaderOptions } from "../structural/parsers/loader.js";

/**
 * Vérifie si le contenu fourni parse sans erreur syntaxique pour le langage
 * du fichier cible.
 *
 * @param content  - Contenu à valider (après résolution des conflits)
 * @param filePath - Chemin du fichier (sélection de la grammaire tree-sitter)
 * @param opts     - Options de chargement (WASM paths, custom loader)
 * @returns
 *   - `true`  : l'arbre syntaxique est valide (pas de nœuds ERROR)
 *   - `false` : des erreurs syntaxiques ont été détectées
 *   - `null`  : tree-sitter indisponible ou langage non supporté
 */
export async function checkParseTreeValid(
  content: string,
  filePath: string,
  opts: LoaderOptions = {},
): Promise<boolean | null> {
  // Vérification rapide : langage supporté ?
  if (!isStructuralLanguage(filePath)) return null;

  try {
    // Chargement lazy de la grammaire (retourne null si non disponible)
    const language = await loadGrammarForFile(filePath, opts);
    if (!language) return null;

    const parser = await createParser(language, opts);
    if (!parser) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = parser as any;
    const tree = p.parse(content);

    // hasParseErrors() vérifie récursivement la présence de nœuds ERROR
    return !hasParseErrors(tree);
  } catch {
    // Graceful degradation — ne jamais bloquer la résolution pour un échec tree-sitter
    return null;
  }
}

/**
 * Construit un objet `HunkResolution` mis à jour avec la pénalité `postMergeRisk`
 * pour signaler qu'une résolution a été rétractée suite à une invalidation parse-tree.
 *
 * Le score de confiance est mis à 0 et le label à "low" pour communiquer clairement
 * à l'UI que ce hunk requiert une intervention manuelle.
 */
export function applyPostMergeRiskPenalty<
  T extends {
    autoResolved: boolean;
    resolvedLines: string[] | null;
    resolutionReason: string;
    hunk: {
      confidence: {
        score: number;
        label: string;
        dimensions: Record<string, unknown>;
        boosters: string[];
        penalties: string[];
      };
    };
  },
>(resolution: T): T {
  return {
    ...resolution,
    autoResolved: false,
    resolvedLines: null,
    resolutionReason:
      "Retracted: the merged content contains syntax errors (tree-sitter parse-tree). Manual intervention required.",
    hunk: {
      ...resolution.hunk,
      confidence: {
        ...resolution.hunk.confidence,
        score: 0,
        label: "low" as const,
        dimensions: {
          ...resolution.hunk.confidence.dimensions,
          postMergeRisk: 100,
        },
        penalties: [
          ...resolution.hunk.confidence.penalties,
          "Parse-tree invalid after automatic resolution",
        ],
      },
    },
  };
}

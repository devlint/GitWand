/**
 * Conflict hunk explanations, fr: one string per `explanationRef` key of
 * `@gitwand/core` (English comes from core's own `explanation`). Kept out
 * of the main locale file: loaded on demand, when an explanation is first shown;
 * typed so that a key core adds does not compile until it is translated.
 */
import type { ExplanationKey } from "@gitwand/core";

const explain: Record<ExplanationKey, string> = {
  sameChange: "Les deux branches ont fait exactement la même modification.",
  whitespaceOnly: "Les deux branches contiennent le même code, aux espaces près.",
  nonOverlapping: "Les branches ont modifié des zones différentes du même bloc : une fusion automatique est possible.",
  complex: "Un vrai conflit, qui demande une décision humaine. Les deux branches ont modifié ce bloc différemment.",
  llmProposed: "Résolution proposée par le recours au LLM. Le bloc est envoyé à l'endpoint LLM configuré pour une résolution assistée, validée (arbre syntaxique puis tsc/eslint) avant de pouvoir être acceptée.",
  oneSideTheirs: "Seule la branche entrante (theirs) a modifié ce bloc. Résolution : prendre theirs.",
  oneSideOurs: "Seule la branche courante (ours) a modifié ce bloc. Résolution : prendre ours.",
  deleteOurs: "La branche courante (ours) a supprimé ce bloc et l'autre n'y a pas touché. Résolution : supprimer.",
  deleteTheirs: "La branche entrante (theirs) a supprimé ce bloc et l'autre n'y a pas touché. Résolution : supprimer.",
  deleteOursNoBase: "La branche courante (ours) a supprimé ce bloc. Sans base, la confiance est moyenne. Résolution proposée : supprimer.",
  deleteTheirsNoBase: "La branche entrante (theirs) a supprimé ce bloc. Sans base, la confiance est moyenne. Résolution proposée : supprimer.",
  insertion: "Les deux branches ont seulement ajouté des lignes, sans modifier la base. Résolution : union des ajouts, ours d'abord.",
  insertionNoBase: "Les deux branches semblent avoir seulement ajouté des lignes (heuristique diff2). Résolution : union, ours d'abord.",
  reorder: "Les deux branches contiennent les mêmes lignes dans un ordre différent. Résolution : prendre l'ordre de theirs, ou celui de ours quand la base correspond à theirs.",
  reorderNoBase: "Les deux branches contiennent les mêmes lignes dans un ordre différent. Résolution : prendre l'ordre de theirs.",
  valueOnly: "Même structure, avec {0} valeur(s) volatile(s) différente(s) (hash, version, horodatage…). Résolution : la version semver la plus haute quand elles sont comparables, sinon ce que dit la politique de fusion.",
  valueOnlyFallback: "Valeurs volatiles différentes.",
  tokenMerge: "Fusion proposée : {0} ligne(s) résolue(s) ligne à ligne, {1} ligne(s) fusionnée(s) token par token. Confirmation requise avant application.",
  tokenMergeFallback: "Fusion au niveau des tokens proposée.",
  refactoringRenames: "Conflit de refactoring : {0} renommage(s) détecté(s) et inversé(s). Résolu par le pipeline RefMerge (inverser, fusionner, rejouer).",
  refactoringMoves: "Conflit de refactoring : {0} déplacement(s) de méthode. Résolu par le pipeline RefMerge (inverser, fusionner, rejouer).",
  refactoringBoth: "Conflit de refactoring : {0} renommage(s) détecté(s) et inversé(s), {1} déplacement(s) de méthode. Résolu par le pipeline RefMerge (inverser, fusionner, rejouer).",
  refactoringDetected: "Conflit de refactoring : refactoring détecté. Résolu par le pipeline RefMerge (inverser, fusionner, rejouer).",
  refactoringFallback: "Conflit causé par un refactoring concurrent, résolu par le pipeline RefMerge.",
  formatSemantic: "Bloc résolu sémantiquement par le résolveur « {0} » (fusion selon la structure du format, pas ligne à ligne).",
  generatedFile: "Fichier généré ({0}). Ce fichier se régénère, il ne se fusionne pas : résolvez sa source, puis relancez l'outil qui le produit (install/build).",
  structuralMerge: "Résolu par une fusion structurelle (AST tree-sitter)",
};

export default explain;

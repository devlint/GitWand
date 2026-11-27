/**
 * The translatable form of a hunk's `explanation`.
 *
 * `explanation` stays the English text every consumer reads (CLI, MCP, VS Code,
 * reports). Next to it, `explanationRef` names the same text as a key plus its
 * positional parameters, so an app can show it in the user's language: the
 * desktop locales have one string per key under `explain`, with `{0}`, `{1}`…
 * for the parameters. A consumer that does not know a key shows `explanation`.
 *
 * `EXPLANATION_PARAMS` maps each key to the number of parameters it takes.
 */
export const EXPLANATION_PARAMS = {
  sameChange: 0,
  whitespaceOnly: 0,
  nonOverlapping: 0,
  complex: 0,
  llmProposed: 0,
  oneSideTheirs: 0,
  oneSideOurs: 0,
  deleteOurs: 0,
  deleteTheirs: 0,
  deleteOursNoBase: 0,
  deleteTheirsNoBase: 0,
  insertion: 0,
  insertionNoBase: 0,
  reorder: 0,
  reorderNoBase: 0,
  /** {0}: number of differing volatile values. */
  valueOnly: 1,
  valueOnlyFallback: 0,
  /** {0}: lines resolved line by line, {1}: lines merged token by token. */
  tokenMerge: 2,
  tokenMergeFallback: 0,
  /** {0}: renames detected and inverted. */
  refactoringRenames: 1,
  /** {0}: method moves. */
  refactoringMoves: 1,
  /** {0}: renames, {1}: method moves. */
  refactoringBoth: 2,
  refactoringDetected: 0,
  refactoringFallback: 0,
  /** {0}: the format resolver's name (`json`, `imports`…). */
  formatSemantic: 1,
  /** {0}: what the generated file is (`npm lockfile`…). */
  generatedFile: 1,
  structuralMerge: 0,
} as const;

export type ExplanationKey = keyof typeof EXPLANATION_PARAMS;

export interface ExplanationRef {
  key: ExplanationKey;
  /** Positional parameters, `{0}`, `{1}`… in the translated string. */
  params?: Array<string | number>;
}

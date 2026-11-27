/**
 * A conflict hunk's explanation in the UI language.
 *
 * `@gitwand/core` writes `explanation` in English (the CLI, MCP and reports
 * read it as is) and names the same text in `explanationRef`: a key and its
 * positional parameters (`{0}`, `{1}`…). Under the English UI the original
 * text is shown, with its exact singular and plural; under another language
 * the string of `locales/explain/<code>.ts`. Those dictionaries are imported
 * here only, so they load with the merge editor, not in the main bundle. A
 * hunk with no known key (an older core, a hunk built elsewhere) keeps its
 * English text.
 */
import { EXPLANATION_PARAMS, type ExplanationKey, type ConflictHunk } from "@gitwand/core";
import { useI18n } from "../composables/useI18n";
import fr from "../locales/explain/fr";
import es from "../locales/explain/es";
import ptBR from "../locales/explain/pt-BR";
import zhCN from "../locales/explain/zh-CN";

const DICTIONARIES: Record<string, Record<ExplanationKey, string>> = { fr, es, "pt-BR": ptBR, "zh-CN": zhCN };

export function hunkExplanation(hunk: Pick<ConflictHunk, "explanation" | "explanationRef">): string {
  const ref = hunk.explanationRef;
  if (!ref || !Object.prototype.hasOwnProperty.call(EXPLANATION_PARAMS, ref.key)) return hunk.explanation;
  const template = DICTIONARIES[useI18n().locale.value]?.[ref.key];
  if (!template) return hunk.explanation;
  return (ref.params ?? []).reduce<string>((text, value, i) => text.replaceAll(`{${i}}`, String(value)), template);
}

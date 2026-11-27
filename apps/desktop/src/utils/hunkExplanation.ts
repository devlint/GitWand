/**
 * A conflict hunk's explanation in the UI language.
 *
 * `@gitwand/core` writes `explanation` in English (the CLI, MCP and reports
 * read it as is) and names the same text in `explanationRef`: a key and its
 * positional parameters (`{0}`, `{1}`…). Under the English UI the original
 * text is shown, with its exact singular and plural; under another language
 * the string of `locales/explain/<code>.ts`.
 *
 * Those dictionaries are loaded on demand, one per language, when the UI
 * language becomes that language: they stay out of the main bundle. Until it
 * has arrived, and for a hunk with no known key (an older core, a hunk built
 * elsewhere), the English text is shown; the cache is reactive, so what is
 * rendered from it updates once it lands.
 */
import { shallowReactive, watch } from "vue";
import { EXPLANATION_PARAMS, type ExplanationKey, type ConflictHunk } from "@gitwand/core";
import { useI18n } from "../composables/useI18n";

type Dictionary = Record<ExplanationKey, string>;

const LOADERS: Record<string, () => Promise<{ default: Dictionary }>> = {
  fr: () => import("../locales/explain/fr"),
  es: () => import("../locales/explain/es"),
  "pt-BR": () => import("../locales/explain/pt-BR"),
  "zh-CN": () => import("../locales/explain/zh-CN"),
};

const dictionaries = shallowReactive<Record<string, Dictionary>>({});
const pending = new Map<string, Promise<void>>();

/** Loads the dictionary of `code` (once); resolves when it is there, or at once for English. */
export function loadExplanations(code: string): Promise<void> {
  const load = LOADERS[code];
  if (!load || dictionaries[code]) return Promise.resolve();
  let p = pending.get(code);
  if (!p) {
    p = load()
      .then((m) => {
        dictionaries[code] = m.default;
      })
      .catch(() => {
        // Left in English; a later language change tries again.
      })
      .finally(() => pending.delete(code));
    pending.set(code, p);
  }
  return p;
}

const { locale } = useI18n();
watch(locale, (code) => void loadExplanations(code), { immediate: true });

export function hunkExplanation(hunk: Pick<ConflictHunk, "explanation" | "explanationRef">): string {
  const ref = hunk.explanationRef;
  if (!ref || !Object.prototype.hasOwnProperty.call(EXPLANATION_PARAMS, ref.key)) return hunk.explanation;
  const template = dictionaries[locale.value]?.[ref.key];
  if (!template) return hunk.explanation;
  // One pass: a parameter holding `{1}` is not substituted again.
  const params = ref.params ?? [];
  return template.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < params.length ? String(params[Number(i)]) : m));
}

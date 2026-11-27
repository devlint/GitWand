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
import type { ExplanationKey, ConflictHunk } from "@gitwand/core";
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
/** When a language's load last failed: it is retried once this long has passed. */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;

/** Loads the dictionary of `code` (once); resolves when it is there, or at once for English. */
export function loadExplanations(code: string): Promise<void> {
  const load = LOADERS[code];
  if (!load || dictionaries[code]) return Promise.resolve();
  let p = pending.get(code);
  if (!p) {
    p = load()
      .then((m) => {
        dictionaries[code] = m.default;
        failedAt.delete(code);
      })
      .catch(() => {
        // Left in English for now; `hunkExplanation` tries again later.
        failedAt.set(code, Date.now());
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
  if (!ref) return hunk.explanation;
  const code = locale.value;
  const dict = dictionaries[code];
  if (!dict) {
    // A failed load is retried, not more often than every RETRY_AFTER_MS.
    const failed = failedAt.get(code);
    if (failed !== undefined && Date.now() - failed >= RETRY_AFTER_MS) void loadExplanations(code);
    return hunk.explanation;
  }
  // Own keys only: an unknown key (an older or newer core) keeps the English text.
  const template = Object.prototype.hasOwnProperty.call(dict, ref.key) ? dict[ref.key] : undefined;
  if (!template) return hunk.explanation;
  // One pass: a parameter holding `{1}` is not substituted again.
  const params = ref.params ?? [];
  return template.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < params.length ? String(params[Number(i)]) : m));
}

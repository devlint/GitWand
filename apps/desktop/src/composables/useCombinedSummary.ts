/**
 * Optional AI summary of what N commits do together (spec §5.5). The prompt
 * carries commit subjects, `path (+a/-d)` for the net diff and bare paths for
 * fallback files — never hunk text. The result is not persisted; errors are
 * exposed for inline display.
 */
import { ref } from "vue";
import { useAIProvider } from "./useAIProvider";
import { localeToAiLanguage } from "./prAiLocale";
import { buildSummaryPromptFromCounts } from "./usePrSummary";
import type { CombinedDiff, GitDiff } from "../utils/backend";
import { rawErrorText } from "../utils/combinedError";
import { latestOnly } from "../utils/latestOnly";

/** The system prompt: the reply language and the commit count. */
export function buildCombinedSystemPrompt(locale: string, n: number): string {
  const lang = localeToAiLanguage(locale);
  return `You write a short summary of what ${n} commits do when taken
together, for a reviewer who hasn't looked at the diff yet.

You will receive the commit subjects (in replay order) and a per-file index
(path + change counts) of everything they touch; files that could not be
combined are listed apart, without counts.

Produce a concise summary in ${lang}, structured as three short sections:
- What: what the commits do together, in plain language.
- Why: the motivation/intent, inferred from the subjects and the files
  touched (say so honestly if it's unclear from the data given).
- Affected areas: the main directories/modules touched, grouped sensibly
  (not a flat file list).

Rules:
- Plain prose with the three section labels ("What:", "Why:", "Affected
  areas:"), no markdown headings, no code fences.
- Be concrete — reference real file/module names from the data.
- Never invent behavior not implied by the commit subjects or file list.
- Keep it under 6 sentences total.`;
}

function countDiff(d: GitDiff): { added: number; deleted: number } {
  let added = 0, deleted = 0;
  for (const h of d.hunks) {
    for (const l of h.lines) {
      if (l.type === "add") added++;
      else if (l.type === "delete") deleted++;
    }
  }
  return { added, deleted };
}

/**
 * Net diffs with their counts; a truncated file has no hunks and is listed
 * with 0/0, never an invented count. Fallback files follow on their own line
 * without counts: their per-commit diffs do not add up to a net change.
 */
export function buildCombinedUserPrompt(c: CombinedDiff): string {
  const net = c.diffs.map((d) => ({ path: d.path, ...countDiff(d) }));
  const prompt = buildSummaryPromptFromCounts(net, c.commits.map((k) => k.subject));
  const apart = [...new Set(c.fallback.map((f) => f.path))];
  if (apart.length === 0) return prompt;
  return [prompt, "", "Files shown commit by commit (not combinable):", ...apart.map((p) => `- ${p}`)].join("\n");
}

export function useCombinedSummary() {
  // Resolved at call time, not module load.
  const ai = useAIProvider();
  const summary = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const guard = latestOnly();

  /** Drop any in-flight request and clear the result (the selection changed). */
  function reset() {
    guard.cancel();
    summary.value = null;
    error.value = null;
    loading.value = false;
  }

  async function generate(c: CombinedDiff, locale: string): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    summary.value = null;
    const r = await guard.settle(
      ai.rawPrompt(buildCombinedSystemPrompt(locale, c.commits.length), buildCombinedUserPrompt(c)),
    );
    if (r.stale) return;
    loading.value = false;
    if (r.ok) summary.value = r.value.trim();
    else error.value = rawErrorText(r.error);
  }

  return { available: ai.isAvailable, summary, loading, error, generate, reset };
}

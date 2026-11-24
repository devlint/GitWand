/**
 * Optional AI summary of what N commits do together (spec §5.5). The prompt
 * carries commit subjects and `path (+a/-d)` only — never hunk text. The
 * result is not persisted; errors are exposed for inline display.
 */
import { ref, type ComputedRef, type Ref } from "vue";
import { useAIProvider } from "./useAIProvider";
import { localeToAiLanguage } from "./prAiLocale";
import { buildSummaryPromptFromCounts } from "./usePrSummary";
import type { CombinedDiff, GitDiff } from "../utils/backend";

export interface CombinedSummaryDeps {
  rawPrompt: (system: string, user: string) => Promise<string>;
  isAvailable: Ref<boolean> | ComputedRef<boolean>;
}

function buildSystemPrompt(locale: string, n: number): string {
  const lang = localeToAiLanguage(locale);
  return `You write a short summary of what ${n} commits do when taken
together, for a reviewer who hasn't looked at the diff yet.

You will receive the commit subjects (in replay order) and a per-file index
(path + change counts) of everything they touch.

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

/** Net diffs + fallback per-commit diffs, summed by path. A truncated file has
 *  no hunks: it is listed with 0/0, never an invented count. */
export function buildCombinedUserPrompt(c: CombinedDiff): string {
  const byPath = new Map<string, { path: string; added: number; deleted: number }>();
  const all = [...c.diffs, ...c.fallback.flatMap((f) => f.perCommit.map((p) => p.diff))];
  for (const d of all) {
    const n = countDiff(d);
    const cur = byPath.get(d.path) ?? { path: d.path, added: 0, deleted: 0 };
    cur.added += n.added;
    cur.deleted += n.deleted;
    byPath.set(d.path, cur);
  }
  return buildSummaryPromptFromCounts([...byPath.values()], c.commits.map((k) => k.subject));
}

export function useCombinedSummary(deps?: CombinedSummaryDeps) {
  // Resolved at call time, not module load.
  const ai = deps ?? useAIProvider();
  const summary = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let gen = 0;

  /** Drop any in-flight request and clear the result (the selection changed). */
  function reset() {
    gen++;
    summary.value = null;
    error.value = null;
    loading.value = false;
  }

  async function generate(c: CombinedDiff, locale: string): Promise<void> {
    if (loading.value) return;
    const my = ++gen;
    loading.value = true;
    error.value = null;
    summary.value = null;
    try {
      const raw = await ai.rawPrompt(buildSystemPrompt(locale, c.commits.length), buildCombinedUserPrompt(c));
      if (my !== gen) return;
      summary.value = raw.trim();
    } catch (e) {
      if (my !== gen) return;
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (my === gen) loading.value = false;
    }
  }

  return { available: ai.isAvailable, summary, loading, error, generate, reset };
}

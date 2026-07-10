/**
 * usePrSummary.ts
 *
 * Opt-in AI PR summary (D1, v3.6.0) — one LLM pass over the PR's indexed
 * diff (A1's per-file index, cheap — no full hunk parse needed for a
 * summary) + commit titles, producing a short what/why/affected-areas
 * block for the Info tab. Cached by `detailKey@headSha` (`usePrCache`).
 */
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeToAiLanguage } from "./prAiLocale";

function buildSystemPrompt(locale: string): string {
  const lang = localeToAiLanguage(locale);
  return `You write a short handoff summary for a pull request, for a
reviewer who hasn't looked at the diff yet.

You will receive the PR's commit titles and a per-file index (path +
change counts) of everything it touches.

Produce a concise summary in ${lang}, structured as three short sections:
- What: what the PR does, in plain language.
- Why: the motivation/intent, inferred from the commit titles and the
  files touched (say so honestly if it's unclear from the data given).
- Affected areas: the main directories/modules touched, grouped sensibly
  (not a flat file list).

Rules:
- Plain prose with the three section labels ("What:", "Why:", "Affected
  areas:"), no markdown headings, no code fences.
- Be concrete — reference real file/module names from the data.
- Never invent behavior not implied by the commit titles or file list.
- Keep it under 6 sentences total.`;
}

export interface SummaryFileEntry {
  path: string;
  /** Raw per-file diff slice (from A1's `indexDiffFiles`) — used only for
   *  a cheap add/delete line count, never the full hunk text (keeps the
   *  prompt small for large PRs). */
  raw: string;
}

function countChanges(raw: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function buildSummaryPrompt(
  files: SummaryFileEntry[],
  commitTitles: string[],
): string {
  const parts: string[] = [];
  parts.push("Commits:");
  if (commitTitles.length) {
    for (const title of commitTitles) parts.push(`- ${title}`);
  } else {
    parts.push("(no commit titles available)");
  }
  parts.push("");
  parts.push("Files touched:");
  for (const f of files) {
    const { additions, deletions } = countChanges(f.raw);
    parts.push(`- ${f.path} (+${additions}/-${deletions})`);
  }
  return parts.join("\n");
}

export interface GenerateSummaryContext {
  cwd: string;
  base: string;
  head: string;
  files: SummaryFileEntry[];
  locale?: string;
}

/** Commit titles for the PR's range — best-effort, tries the plain branch
 *  names first (works when the PR branches are fetched locally), falls
 *  back to `origin/<base>..origin/<head>`, and finally gives up gracefully
 *  (an empty list — the summary still generates from the file index alone). */
async function commitTitlesForRange(cwd: string, base: string, head: string): Promise<string[]> {
  if (!base || !head) return [];
  for (const range of [`${base}..${head}`, `origin/${base}..origin/${head}`]) {
    const res = await gitExec(cwd, ["log", "--format=%s", range]).catch(() => null);
    if (res && res.exitCode === 0) {
      const titles = (res.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (titles.length) return titles;
    }
  }
  return [];
}

export function usePrSummary() {
  const ai = useAIProvider();

  async function generate(ctx: GenerateSummaryContext): Promise<string> {
    if (!ai.isAvailable.value) return "";
    if (!ctx.files.length) return "";
    const commitTitles = await commitTitlesForRange(ctx.cwd, ctx.base, ctx.head);
    const systemPrompt = buildSystemPrompt(ctx.locale ?? "en");
    const userPrompt = buildSummaryPrompt(ctx.files, commitTitles);
    const raw = await ai.rawPrompt(systemPrompt, userPrompt).catch(() => "");
    return raw.trim();
  }

  return { generate };
}

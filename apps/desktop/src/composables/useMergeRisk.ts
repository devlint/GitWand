import { ref } from "vue";
import { useAIProvider } from "./useAIProvider";
import type { MergePreviewSummary, PreviewFileResult } from "./useMergePreview";

/**
 * "Should I merge?" — turns a `MergePreviewSummary` into a short,
 * human-readable risk assessment using the configured AI provider.
 *
 * The LLM receives:
 *   - The branch names (source / target).
 *   - The aggregate counts (clean / auto / partial / manual).
 *   - The list of files touched, with per-file status, conflict
 *     counts, and conflict types.
 *
 * It returns a 2–4 sentence plain-language assessment that the user
 * can read BEFORE kicking off a real merge: typical outputs flag
 * files that are likely to carry regression risk ("auth / DB / the
 * files touched by recent hotfixes"), or confirm that the merge is
 * effectively safe when the diff is just config drift.
 */

export interface MergeRiskOptions {
  /** UI locale (drives the response language). Defaults to "fr". */
  locale?: string;
  /** Max number of files listed to the LLM (default 60). */
  maxFiles?: number;
}

function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You are a senior engineer advising whether a Git branch merge is
safe to perform.

You will receive:
- The source branch name.
- The target branch name.
- Aggregate counts (clean / auto-resolvable / partial / manual / add-delete).
- A list of files touched by the merge, with per-file status and
  detected conflict types.

Write a concise assessment (2–4 short sentences, under 500 characters)
covering, in this order:
1. The overall verdict ("safe merge", "review these N files", "risk of
   regression in X", etc.).
2. What specifically stands out — name file paths or directories that
   deserve attention (auth / database / migrations / API surface / CI).
3. One actionable recommendation (e.g. "run the auth integration
   tests", "review the migration manually", "no action needed").

Rules:
- Write in ${lang}, natural prose — no code fences, no bullet list.
- Never invent files or conflict details that aren't in the provided
  data.
- If every file is "clean" or "auto-resolved", say so honestly rather
  than manufacturing risk.
- File paths in your answer MUST match paths from the provided list
  (don't rename or guess).`;
}

function describeFile(f: PreviewFileResult): string {
  const types = f.conflictTypes.length > 0 ? ` [${f.conflictTypes.join(", ")}]` : "";
  const counts = f.totalConflicts > 0
    ? ` — ${f.autoResolved}/${f.totalConflicts} auto`
    : "";
  return `- (${f.status}) ${f.filePath}${counts}${types}`;
}

function buildUserPrompt(
  source: string,
  target: string,
  summary: MergePreviewSummary,
  maxFiles: number,
): string {
  const files = summary.files.slice(0, maxFiles);
  const over = summary.files.length - files.length;

  const parts: string[] = [];
  parts.push(`Source branch: ${source}`);
  parts.push(`Target branch: ${target}`);
  parts.push("");
  parts.push("Aggregate counts:");
  parts.push(`- clean:            ${summary.cleanFiles}`);
  parts.push(`- auto-resolvable:  ${summary.autoResolvableFiles}`);
  parts.push(`- manual:           ${summary.manualFiles}`);
  parts.push(`- total with conflicts: ${summary.conflictingFiles}`);
  parts.push(`- fully automatable: ${summary.fullyAutoMergeable ? "yes" : "no"}`);
  parts.push("");
  parts.push("Files:");
  for (const f of files) parts.push(describeFile(f));
  if (over > 0) parts.push(`... and ${over} more file(s) not listed.`);
  parts.push("");
  parts.push("Write the risk assessment.");
  return parts.join("\n");
}

function cleanAssessment(raw: string | undefined | null): string {
  if (!raw) return "";
  let msg = raw.trim();
  const fence = msg.match(/^```(?:[a-z]*)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) msg = fence[1].trim();
  return msg;
}

const isAssessing = ref(false);
const lastError = ref<string | null>(null);

export function useMergeRisk() {
  const ai = useAIProvider();

  async function assess(
    targetBranch: string,
    summary: MergePreviewSummary,
    options: MergeRiskOptions = {},
  ): Promise<string> {
    const { locale = "fr", maxFiles = 60 } = options;

    isAssessing.value = true;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!summary) throw new Error("Aucun aperçu de merge à analyser.");
      if (!summary.sourceBranch || !targetBranch) {
        throw new Error("Branche source ou cible manquante.");
      }

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(
        summary.sourceBranch,
        targetBranch,
        summary,
        maxFiles,
      );

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }
      return cleanAssessment(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.value = msg;
      throw err;
    } finally {
      isAssessing.value = false;
    }
  }

  return {
    isAssessing,
    lastError,
    assess,
  };
}

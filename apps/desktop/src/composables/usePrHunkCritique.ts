import { ref } from "vue";
import type { DiffHunk } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Per-hunk AI code review: given one unified-diff hunk, asks the
 * configured AI provider for a short, actionable review comment.
 *
 * The LLM is told to behave like a senior engineer leaving a PR
 * review — point out bugs, edge cases, security concerns, or
 * missing tests, but keep it brief and drop perf-nitpicks when
 * there's nothing real to say.
 */

export interface HunkCritiqueOptions {
  /** UI locale — drives the response language. */
  locale?: string;
  /** Max characters sent per hunk (default 3 000). */
  maxHunkChars?: number;
}

export interface HunkCritiqueResult {
  /** "ok" means the LLM found nothing worth flagging. */
  verdict: "ok" | "nit" | "suggestion" | "risk";
  /** Short human-readable prose, 1–3 sentences. */
  summary: string;
}

function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You are a senior engineer reviewing one hunk of a pull
request diff.

You will receive:
- The file path.
- The hunk header (line ranges).
- The hunk's unified-diff content (context / added / removed lines).

Produce a short, actionable review in strict JSON:
{
  "verdict": "ok" | "nit" | "suggestion" | "risk",
  "summary": "<1–3 short sentences in ${lang}>"
}

Verdict scale (strict):
- "ok"         → nothing to flag; the hunk looks fine.
- "nit"        → minor readability / style issue, nothing critical.
- "suggestion" → a concrete improvement (naming, edge case, missing
                 null check, missing test).
- "risk"       → potential bug, security issue, breaking change, or
                 a behaviour regression.

Rules:
- Be concrete. Quote a line / symbol when it helps, but DO NOT
  paste the whole hunk back.
- If the hunk is trivial (whitespace, comment tweak, formatting),
  verdict MUST be "ok" and summary MUST acknowledge that.
- Never invent symbols or behaviours that aren't in the hunk.
- Write the summary in ${lang}. No code fences, no markdown
  headings, no preamble. Output ONLY the JSON object.`;
}

function hunkToText(filePath: string, hunk: DiffHunk, maxChars: number): string {
  const lines: string[] = [];
  lines.push(`File: ${filePath}`);
  lines.push(`Hunk: ${hunk.header}`);
  lines.push("");
  for (const line of hunk.lines) {
    const marker = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
    lines.push(`${marker} ${line.content}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + "\n... (truncated)";
}

function extractJson(raw: string): HunkCritiqueResult | null {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (brace !== -1 && lastBrace > brace) s = s.slice(brace, lastBrace + 1);
  try {
    const obj = JSON.parse(s);
    const verdictRaw = typeof obj?.verdict === "string" ? obj.verdict : "";
    const verdict: HunkCritiqueResult["verdict"] =
      verdictRaw === "ok" || verdictRaw === "nit"
      || verdictRaw === "suggestion" || verdictRaw === "risk"
        ? verdictRaw
        : "suggestion";
    const summary = typeof obj?.summary === "string" ? obj.summary.trim() : "";
    if (!summary) return null;
    return { verdict, summary };
  } catch {
    return null;
  }
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);

export function usePrHunkCritique() {
  const ai = useAIProvider();

  async function critique(
    filePath: string,
    hunk: DiffHunk,
    options: HunkCritiqueOptions = {},
  ): Promise<HunkCritiqueResult> {
    const { locale = "fr", maxHunkChars = 3000 } = options;

    isGenerating.value = true;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!hunk || !hunk.lines?.length) {
        throw new Error("Hunk vide — rien à analyser.");
      }

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = hunkToText(filePath, hunk, maxHunkChars);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }
      const parsed = extractJson(raw);
      if (!parsed) {
        // Fallback: treat the raw response as a suggestion so the user
        // still gets something useful when the model dodges the JSON
        // contract.
        return { verdict: "suggestion", summary: raw.trim().slice(0, 500) };
      }
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.value = msg;
      throw err;
    } finally {
      isGenerating.value = false;
    }
  }

  return {
    isGenerating,
    lastError,
    critique,
  };
}

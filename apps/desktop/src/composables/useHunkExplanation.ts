import { ref } from "vue";
import type { ConflictHunk } from "@gitwand/core";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";

/**
 * Asks the configured AI provider to translate a hunk's deterministic
 * DecisionTrace into a short, human-readable explanation. The goal is to
 * turn "selected=complex, steps=[same_change rejected (diverging), …]" into
 * "Les deux branches modifient la signature de `login()` — fusion manuelle
 * requise."
 *
 * Reuses the same multi-provider plumbing as `useAIProvider` (Claude API,
 * Claude Code CLI, OpenAI-compat, Ollama).
 */

export interface HunkExplainOptions {
  /** UI locale — drives the response language. */
  locale?: string;
  /** File path for prompt context (helps the model reason about intent). */
  filePath?: string;
  /** Max characters kept from each side of the hunk (default 1500). */
  maxSideChars?: number;
}

function localeToEnglishName(code: string): string {
  const map: Record<string, string> = {
    fr: "French", en: "English", es: "Spanish", de: "German",
    it: "Italian", pt: "Portuguese", ja: "Japanese", ko: "Korean",
    zh: "Chinese", nl: "Dutch", ru: "Russian", ar: "Arabic",
    pl: "Polish", sv: "Swedish", da: "Danish", nb: "Norwegian",
  };
  return map[code] ?? localeLabels[code as SupportedLocale] ?? code;
}

function buildSystemPrompt(locale: string): string {
  const lang = localeToEnglishName(locale);
  return `You are a senior engineer explaining a Git merge conflict to a
teammate who is about to resolve it.

You will receive:
- The deterministic decision trace produced by GitWand's resolver
  (which pattern was considered, which passed, and the one-line summary
  of the final classification).
- The conflicting content on both sides (ours / theirs) and, if available,
  the common ancestor (base).

Write a concise explanation (2–4 short sentences) that covers:
1. What each side is trying to do (summarise the INTENT, not the syntax).
2. Why GitWand cannot auto-resolve this hunk (point to the concrete
   pattern/step that rejected auto-resolution).
3. What the reader should look for when resolving manually.

Rules:
- Write in ${lang}, natural prose — no code fences, no lists, no preamble.
- Never invent context that isn't in the provided data.
- If the two sides look semantically equivalent, say so and suggest
  picking either.
- Keep the whole answer under 400 characters.`;
}

function stepsToText(hunk: ConflictHunk): string {
  const lines = hunk.trace.steps.map((s) => {
    const marker = s.passed ? "[selected]" : "[rejected]";
    return `${marker} ${s.type}: ${s.reason}`;
  });
  return lines.join("\n");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}

function buildUserPrompt(
  hunk: ConflictHunk,
  filePath: string | undefined,
  maxSideChars: number,
): string {
  const ours = clip(hunk.oursLines.join("\n"), maxSideChars);
  const theirs = clip(hunk.theirsLines.join("\n"), maxSideChars);
  const base = hunk.baseLines.length > 0 ? clip(hunk.baseLines.join("\n"), maxSideChars) : null;

  const parts: string[] = [];
  if (filePath) parts.push(`File: ${filePath}`);
  parts.push(`Selected classification: ${hunk.trace.selected}`);
  parts.push(`GitWand summary: ${hunk.trace.summary}`);
  parts.push(`Has base (diff3): ${hunk.trace.hasBase}`);
  parts.push("");
  parts.push("Decision trace (in evaluation order):");
  parts.push(stepsToText(hunk));
  parts.push("");
  if (base !== null) {
    parts.push("--- base ---");
    parts.push(base || "(empty)");
  }
  parts.push("--- ours ---");
  parts.push(ours || "(empty)");
  parts.push("--- theirs ---");
  parts.push(theirs || "(empty)");
  parts.push("");
  parts.push("Explain this conflict.");
  return parts.join("\n");
}

function cleanExplanation(raw: string | undefined | null): string {
  if (!raw) return "";
  let msg = raw.trim();
  const fence = msg.match(/^```(?:[a-z]*)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) msg = fence[1].trim();
  return msg;
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);

export function useHunkExplanation() {
  const ai = useAIProvider();

  async function explain(
    hunk: ConflictHunk,
    options: HunkExplainOptions = {},
  ): Promise<string> {
    const { locale = "fr", filePath, maxSideChars = 1500 } = options;

    isGenerating.value = true;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(hunk, filePath, maxSideChars);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }
      return cleanExplanation(raw);
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
    explain,
  };
}

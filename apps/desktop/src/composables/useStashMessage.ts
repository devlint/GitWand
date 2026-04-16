import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";

/**
 * Generates a stash message from the current working-tree diff.
 *
 * Uses the same multi-provider plumbing as {@link useCommitMessage}, so the
 * feature works with Claude API, Claude Code CLI, any OpenAI-compatible
 * endpoint, or a local Ollama instance.
 */

export interface StashMessageOptions {
  /** Locale code (e.g. "fr", "en") for the generated message. */
  locale?: string;
  /** Max number of diff characters sent to the model (default 12k). */
  maxDiffChars?: number;
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
  return `You are a senior software engineer writing a short stash label.

A stash label is a one-line description of a work-in-progress change that will
be shown in \`git stash list\`. It helps the developer recognise the stash
later.

Rules:
1. Output ONE line only, 72 characters maximum.
2. Start with "wip:" then a short imperative summary of what the change is about.
3. No trailing period, no code fences, no explanations.
4. Write in ${lang}.
5. Focus on INTENT ("wip: refactor user service tests") rather than mechanics
   ("wip: change 12 files"). Look at the diff to infer what the dev is doing.`;
}

function buildUserPrompt(diff: string, status: string): string {
  return `Summarise this in-progress work as a short stash label.

--- git status ---
${status.trim() || "(empty)"}

--- git diff (working tree) ---
${diff.trim() || "(empty)"}

Write the stash label.`;
}

function cleanMessage(raw: string | undefined | null): string {
  if (!raw) return "";
  let msg = raw.trim();
  const fence = msg.match(/^```(?:[a-z]*)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) msg = fence[1].trim();
  msg = msg.replace(/^stash(\s+label|\s+message)?:\s*/i, "").trim();
  // Keep only the first non-empty line.
  const firstLine = msg.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim();
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastMessage = ref<string | null>(null);

export function useStashMessage() {
  const ai = useAIProvider();

  async function generate(
    cwd: string,
    options: StashMessageOptions = {},
  ): Promise<string> {
    const { locale = "fr", maxDiffChars = 12_000 } = options;

    isGenerating.value = true;
    lastError.value = null;
    lastMessage.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!cwd) {
        throw new Error("Aucun repo ouvert (cwd vide).");
      }

      // The stash captures staged + unstaged + untracked. We feed the model a
      // combined view so it can reason about the whole WIP, not just one layer.
      let diffRes, statusRes;
      try {
        [diffRes, statusRes] = await Promise.all([
          gitExec(cwd, ["diff", "HEAD", "--no-color"]),
          gitExec(cwd, ["status", "--short"]),
        ]);
      } catch (execErr: unknown) {
        throw new Error(
          `git exec failed: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        );
      }

      let diff = diffRes.stdout ?? "";
      const status = statusRes.stdout ?? "";
      if (diff.length === 0 && status.trim().length === 0) {
        throw new Error(
          "Aucun changement local à stasher — modifie des fichiers avant de générer un message.",
        );
      }
      if (diff.length > maxDiffChars) {
        diff = diff.slice(0, maxDiffChars) + "\n... (diff truncated)";
      }

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(diff, status);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }
      const message = cleanMessage(raw);
      lastMessage.value = message;
      return message;
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
    lastMessage,
    generate,
  };
}

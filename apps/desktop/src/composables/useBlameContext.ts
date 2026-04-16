import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * "Why did this line change?" — given a commit hash and a file path,
 * asks the configured AI provider to summarise the intent of the
 * change in plain language.
 *
 * The composable fetches:
 *   - The commit's full message (`git show -s --format=%B`)
 *   - The diff that this commit introduced in the given file
 *     (`git show <hash> -- <path>`)
 *
 * and feeds both to the LLM with a "be concise, explain the intent"
 * system prompt. Results are cached per commit so switching between
 * blame blocks is cheap.
 */

export interface BlameExplainOptions {
  /** UI locale (drives the response language). */
  locale?: string;
  /** Max characters of per-file diff sent to the model (default 4k). */
  maxDiffChars?: number;
  /** Max characters of commit message body kept (default 2k). */
  maxBodyChars?: number;
}

function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You help a developer understand why a specific commit changed a file.

You will receive:
- The full commit message (subject + body).
- The diff introduced by that commit in a single file (the lines the
  user is asking about).

Write a concise explanation (2–4 short sentences, under 400 characters)
covering, in this order:
1. What INTENT the commit expresses (what problem it solves or what
   it adds / refactors).
2. What the file-level change is actually doing (the mechanics).
3. Any caveat worth knowing (e.g. "this is a breaking change",
   "only covers the fallback path", etc.) — omit if nothing stands out.

Rules:
- Write in ${lang}, natural prose — no code fences, no bullet list,
  no preamble like "This commit…".
- Never invent context that isn't in the provided data.
- If the commit message is empty or generic and the diff is trivial,
  say so honestly rather than inventing a grand narrative.`;
}

function buildUserPrompt(
  filePath: string,
  shortHash: string,
  fullMessage: string,
  fileDiff: string,
): string {
  const parts: string[] = [];
  parts.push(`File: ${filePath}`);
  parts.push(`Commit: ${shortHash}`);
  parts.push("");
  parts.push("--- commit message ---");
  parts.push(fullMessage.trim() || "(empty)");
  parts.push("");
  parts.push("--- diff (this commit, this file only) ---");
  parts.push(fileDiff.trim() || "(empty)");
  parts.push("");
  parts.push("Explain this change.");
  return parts.join("\n");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
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

/**
 * Cache of past explanations keyed by `${hashFull}::${filePath}` so
 * repeated clicks on the same block don't re-hit the provider.
 */
const cache = new Map<string, string>();

export function useBlameContext() {
  const ai = useAIProvider();

  async function explain(
    cwd: string,
    hashFull: string,
    filePath: string,
    options: BlameExplainOptions = {},
  ): Promise<string> {
    const { locale = "fr", maxDiffChars = 4_000, maxBodyChars = 2_000 } = options;

    const cacheKey = `${hashFull}::${filePath}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    isGenerating.value = true;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!cwd || !hashFull || !filePath) {
        throw new Error("Paramètres manquants (cwd, commit ou fichier).");
      }

      const [msgRes, diffRes, shortRes] = await Promise.all([
        gitExec(cwd, ["show", "-s", "--format=%B", hashFull]),
        gitExec(cwd, ["show", hashFull, "--no-color", "--", filePath]),
        gitExec(cwd, ["rev-parse", "--short", hashFull]),
      ]);

      if (msgRes.exitCode !== 0) {
        throw new Error(msgRes.stderr || "git show (message) failed");
      }
      const fullMessage = clip(msgRes.stdout ?? "", maxBodyChars);

      // `git show <hash> -- <path>` outputs the commit header + diff.
      // That's fine — the LLM handles the mix.
      const fileDiff = clip((diffRes.stdout ?? "").trim(), maxDiffChars);
      if (!fileDiff) {
        throw new Error(
          "Aucun changement de ce commit sur ce fichier (le blame pointe peut-être vers un merge).",
        );
      }
      const shortHash = (shortRes.stdout ?? "").trim() || hashFull.slice(0, 7);

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(filePath, shortHash, fullMessage, fileDiff);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }
      const clean = cleanExplanation(raw);
      if (clean) cache.set(cacheKey, clean);
      return clean;
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

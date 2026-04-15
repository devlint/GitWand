import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Generates commit messages from the currently staged diff.
 *
 * Relies on `useAIProvider` under the hood, so it works with every provider
 * configured in Settings (Anthropic API, Claude Code CLI, OpenAI-compatible,
 * Ollama). The Claude Code CLI path is the most interesting here: it lets
 * users generate commit messages using their Claude Max/Pro subscription
 * without having to configure an API key.
 */

export interface CommitMessageOptions {
  /** "fr" or "en" — locale used for the message body when style is "conventional". */
  locale?: "fr" | "en";
  /** Max number of diff characters sent to the model (default 16k). */
  maxDiffChars?: number;
}

function buildSystemPrompt(locale: "fr" | "en"): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
   Valid types: feat, fix, refactor, perf, docs, test, chore, build, ci, style.
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. After the subject, leave a blank line, then optionally add a short body (1-3 lines)
   explaining *why* the change was made. Skip the body for trivial changes.
4. Write in ${lang}.
5. Never include "Co-Authored-By", "Signed-off-by", or any other trailer.
6. Never wrap your answer in code fences or add explanations — output ONLY the
   raw commit message, ready to be passed to \`git commit -m\`.`;
}

function buildUserPrompt(diff: string, status: string): string {
  return `Here is the staged change to describe.

--- git status (staged files) ---
${status.trim() || "(empty)"}

--- git diff --cached ---
${diff.trim() || "(empty)"}

Write the commit message.`;
}

/** Strip code fences / leading labels the model sometimes adds anyway. */
function cleanMessage(raw: string): string {
  let msg = raw.trim();
  const fence = msg.match(/^```(?:[a-z]*)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) msg = fence[1].trim();
  // Some models prefix with "Commit message:" — strip it.
  msg = msg.replace(/^commit message:\s*/i, "").trim();
  return msg;
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastMessage = ref<string | null>(null);

export function useCommitMessage() {
  const ai = useAIProvider();

  /**
   * Generate a commit message from the current staged diff.
   *
   * @throws if no provider is configured or the model call fails.
   */
  async function generate(
    cwd: string,
    options: CommitMessageOptions = {},
  ): Promise<string> {
    const { locale = "fr", maxDiffChars = 16_000 } = options;

    isGenerating.value = true;
    lastError.value = null;
    lastMessage.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }

      // Pull the staged diff + a short status summary via the existing
      // git_exec primitive — no new backend command needed.
      const [diffRes, statusRes] = await Promise.all([
        gitExec(cwd, ["diff", "--cached", "--no-color"]),
        gitExec(cwd, ["diff", "--cached", "--name-status"]),
      ]);

      if (diffRes.exitCode !== 0) {
        throw new Error(
          diffRes.stderr.trim() || "git diff --cached a échoué",
        );
      }

      let diff = diffRes.stdout;
      if (diff.length === 0) {
        throw new Error("Aucun changement stagé — stage des fichiers avant de générer un message.");
      }
      if (diff.length > maxDiffChars) {
        diff = diff.slice(0, maxDiffChars) + "\n... (diff truncated)";
      }

      // We call the provider directly through the same mechanism used for
      // conflict resolution. The `suggest()` API expects a ConflictContext,
      // which is the wrong shape here, so we re-implement the minimal
      // provider dispatch by rebuilding the prompts and going through the
      // provider's underlying call. To keep this simple, we hijack the
      // suggest path by encoding the commit-message request as a fake
      // conflict — but that's ugly. Cleaner: expose a free-form `prompt`
      // call from useAIProvider. For now we go direct via the CLI / HTTP
      // layers by piggybacking on the existing provider config.
      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(diff, statusRes.stdout);

      // Use the provider's own free-form prompt entry point.
      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
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

import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";
import { t } from "./useI18n";

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
  /** Locale code (e.g. "fr", "en", "es") — language used for the commit message. */
  locale?: string;
  /** Max number of diff characters sent to the model (default 16k). */
  maxDiffChars?: number;
  /**
   * Override the entire system prompt (v2.13 preset system).
   * The string may contain `${lang}` which is replaced with the resolved language
   * name (e.g. "French") before being sent to the model.
   */
  systemPromptOverride?: string;
}

export type CommitMessageAction = "shorten" | "detail" | "changeLang";

/** Map locale codes to their English name for prompts. Falls back to the locale label or code itself. */
function localeToEnglishName(code: string): string {
  const map: Record<string, string> = {
    fr: "French", en: "English", es: "Spanish", de: "German",
    it: "Italian", pt: "Portuguese", ja: "Japanese", ko: "Korean",
    zh: "Chinese", nl: "Dutch", ru: "Russian", ar: "Arabic",
    pl: "Polish", sv: "Swedish", da: "Danish", nb: "Norwegian",
  };
  return map[code] ?? localeLabels[code as SupportedLocale] ?? code;
}

function buildTransformPrompt(action: CommitMessageAction, currentMessage: string, targetLocale?: string): { system: string; user: string } {
  const base = `You are a senior software engineer editing a Git commit message.
Rules:
1. Follow Conventional Commits: "<type>(<optional scope>): <subject>".
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. Do not include trailers (Co-Authored-By, Signed-off-by…) — the user adds those separately.
4. Output ONLY the raw commit message — no code fences, no explanations.`;

  switch (action) {
    case "shorten":
      return {
        system: `${base}\n5. Make the message shorter and more concise. Remove the body if it exists. Keep only the essential information in the subject.`,
        user: `Shorten this commit message:\n\n${currentMessage}`,
      };
    case "detail":
      return {
        system: `${base}\n5. Make the message more detailed. Add a body (2-4 lines) explaining WHY the change was made and WHAT it impacts. Keep the subject line intact or improve it.`,
        user: `Add more detail to this commit message:\n\n${currentMessage}`,
      };
    case "changeLang": {
      const lang = localeToEnglishName(targetLocale ?? "en");
      return {
        system: `${base}\n5. Translate the commit message to ${lang}. Keep the type/scope prefix as-is (they stay in English). Translate only the subject text and body.`,
        user: `Translate this commit message to ${lang}:\n\n${currentMessage}`,
      };
    }
  }
}

function buildSystemPrompt(locale: string): string {
  const lang = localeToEnglishName(locale);
  return `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
   Valid types: feat, fix, refactor, perf, docs, test, chore, build, ci, style.
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. After the subject, leave a blank line, then optionally add a short body (1-3 lines)
   explaining *why* the change was made. Skip the body for trivial changes.
4. Write in ${lang}.
5. Do not include trailers (Co-Authored-By, Signed-off-by, Reviewed-by…) — the user controls those via the GitWand trailer checkboxes.
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
function cleanMessage(raw: string | undefined | null): string {
  if (!raw) return "";
  let msg = raw.trim();
  const fence = msg.match(/^```(?:[a-z]*)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) msg = fence[1].trim();
  // Some models prefix with "Commit message:" — strip it.
  msg = msg.replace(/^commit message:\s*/i, "").trim();
  return msg;
}

const isGenerating = ref(false);
/** Repo the in-flight generation/transform belongs to (null when unknown). */
const generatingCwd = ref<string | null>(null);
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
    const { locale = "fr", maxDiffChars = 16_000, systemPromptOverride } = options;

    isGenerating.value = true;
    generatingCwd.value = cwd;
    lastError.value = null;
    lastMessage.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(t("errors.noAiProvider"));
      }

      // Pull the staged diff + a short status summary via the existing
      // git_exec primitive — no new backend command needed.
      if (!cwd) {
        throw new Error(t("errors.noRepoOpen"));
      }

      let diffRes, statusRes;
      try {
        [diffRes, statusRes] = await Promise.all([
          gitExec(cwd, ["diff", "--cached", "--no-color"]),
          gitExec(cwd, ["diff", "--cached", "--name-status"]),
        ]);
      } catch (execErr: unknown) {
        throw new Error(
          `git exec failed: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        );
      }

      if (diffRes.exitCode !== 0) {
        const stderr = (diffRes.stderr ?? "").trim();
        throw new Error(
          stderr
            || `git diff --cached a échoué (exit ${diffRes.exitCode}, cwd: ${cwd})`,
        );
      }

      let diff = diffRes.stdout ?? "";
      if (diff.length === 0) {
        throw new Error(t("errors.noStagedChanges"));
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
      // Apply preset override if provided, otherwise use the default prompt.
      // The ${lang} placeholder in preset prompts is substituted at this point.
      const lang = localeToEnglishName(locale);
      const systemPrompt = systemPromptOverride
        ? systemPromptOverride.replace(/\$\{lang\}/g, lang)
        : buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(diff, statusRes.stdout ?? "");

      // Use the provider's own free-form prompt entry point.
      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error(t("errors.emptyAiResponse"));
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
      generatingCwd.value = null;
    }
  }

  /**
   * Transform an existing commit message: shorten, add detail, or change language.
   */
  async function transform(
    action: CommitMessageAction,
    currentMessage: string,
    targetLocale?: string,
    cwd?: string,
  ): Promise<string> {
    isGenerating.value = true;
    generatingCwd.value = cwd ?? null;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(t("errors.noAiProviderShort"));
      }
      if (!currentMessage.trim()) {
        throw new Error(t("errors.noMessageToTransform"));
      }

      const { system, user } = buildTransformPrompt(action, currentMessage, targetLocale);
      const raw = await ai.rawPrompt(system, user);
      if (!raw) throw new Error(t("errors.emptyAiResponse"));

      const message = cleanMessage(raw);
      lastMessage.value = message;
      return message;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.value = msg;
      throw err;
    } finally {
      isGenerating.value = false;
      generatingCwd.value = null;
    }
  }

  return {
    isGenerating,
    generatingCwd,
    lastError,
    lastMessage,
    generate,
    transform,
  };
}

import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";
import { t } from "./useI18n";
import { applyLang, DEFAULT_TEMPLATE_PROMPTS } from "./aiTemplateDefaults";
import { getActiveTemplate } from "./useAiTemplates";

/**
 * Generates a structured Pull Request title + body from the commits
 * between a head branch and a base branch. Reuses the same multi-provider
 * plumbing as {@link useCommitMessage} (Claude API, Claude Code CLI,
 * OpenAI-compat, Ollama) via {@link useAIProvider.rawPrompt}.
 */

export interface PrDescription {
  title: string;
  body: string;
}

export interface PrDescriptionOptions {
  /** UI locale — drives the response language. Defaults to "fr". */
  locale?: string;
  /** Max number of diffstat bytes sent to the model (default 8k). */
  maxStatChars?: number;
  /** Max number of commit messages kept (default 40). */
  maxCommits?: number;
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

/**
 * The system prompt: the repo's active PR template if one is selected,
 * otherwise the default prompt. `${lang}` is substituted either way.
 */
function buildSystemPrompt(cwd: string, locale: string): string {
  const template = getActiveTemplate("pr", cwd);
  return applyLang(
    template?.systemPrompt ?? DEFAULT_TEMPLATE_PROMPTS.pr,
    localeToEnglishName(locale),
  );
}

function buildUserPrompt(
  head: string,
  base: string,
  commits: string,
  diffstat: string,
): string {
  return `Head branch: ${head}
Base branch: ${base}

--- commits (${head} not in ${base}, newest first) ---
${commits.trim() || "(no commits yet)"}

--- diffstat (${base}..${head}) ---
${diffstat.trim() || "(empty)"}

Write the PR description.`;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}

function extractJson(raw: string): { title?: string; body?: string } | null {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  // Some models prefix with text before the JSON — grab the first {...} block.
  const brace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (brace !== -1 && lastBrace > brace) {
    s = s.slice(brace, lastBrace + 1);
  }
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object") {
      return {
        title: typeof obj.title === "string" ? obj.title : undefined,
        body: typeof obj.body === "string" ? obj.body : undefined,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^\s*title:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, 120);
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastResult = ref<PrDescription | null>(null);

export function usePrDescription() {
  const ai = useAIProvider();

  async function generate(
    cwd: string,
    headBranch: string,
    baseBranch: string,
    options: PrDescriptionOptions = {},
  ): Promise<PrDescription> {
    const { locale = "fr", maxStatChars = 8_000, maxCommits = 40 } = options;

    isGenerating.value = true;
    lastError.value = null;
    lastResult.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(t("errors.noAiProvider"));
      }
      if (!cwd) throw new Error(t("errors.noRepoOpen"));
      if (!headBranch || !baseBranch) {
        throw new Error(t("errors.missingBranch"));
      }
      if (headBranch === baseBranch) {
        throw new Error(t("errors.sameBranches"));
      }

      const range = `${baseBranch}..${headBranch}`;
      let logRes, statRes;
      try {
        [logRes, statRes] = await Promise.all([
          // Commit subject + body, newest first. Delimited to keep parsing trivial.
          gitExec(cwd, [
            "log",
            range,
            `--max-count=${maxCommits}`,
            "--no-decorate",
            "--no-color",
            "--pretty=format:--- %h%n%s%n%b",
          ]),
          gitExec(cwd, ["diff", "--stat", "--no-color", range]),
        ]);
      } catch (execErr: unknown) {
        throw new Error(
          `git exec failed: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        );
      }

      if (logRes.exitCode !== 0) {
        const stderr = (logRes.stderr ?? "").trim();
        throw new Error(
          stderr || `git log ${range} failed (exit ${logRes.exitCode})`,
        );
      }

      const commits = (logRes.stdout ?? "").trim();
      if (!commits) {
        throw new Error(t("errors.noCommitsInRange", baseBranch, headBranch));
      }
      const diffstat = clip((statRes.stdout ?? "").trim(), maxStatChars);

      const systemPrompt = buildSystemPrompt(cwd, locale);
      const userPrompt = buildUserPrompt(headBranch, baseBranch, commits, diffstat);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error(t("errors.emptyAiResponse"));
      }

      const parsed = extractJson(raw);
      let title = "";
      let body = "";
      if (parsed?.title || parsed?.body) {
        title = cleanTitle(parsed.title ?? "");
        body = (parsed.body ?? "").trim();
      } else {
        // Fallback: first line = title, rest = body.
        const lines = raw.trim().split(/\r?\n/);
        title = cleanTitle(lines[0] ?? "");
        body = lines.slice(1).join("\n").trim();
      }

      if (!title && !body) {
        throw new Error(
          "La réponse du provider IA n'a pas pu être interprétée (title/body manquants).",
        );
      }

      const result: PrDescription = { title, body };
      lastResult.value = result;
      return result;
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
    lastResult,
    generate,
  };
}

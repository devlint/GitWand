import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";

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

function buildSystemPrompt(locale: string): string {
  const lang = localeToEnglishName(locale);
  return `You are a senior engineer drafting a GitHub Pull Request description.

You will receive:
- The head branch name
- The base branch name
- The list of commits between base..head (most recent first)
- A diffstat summary (files changed + added/deleted lines)

Produce a JSON object with exactly two keys: "title" and "body".

Title rules:
- Single line, 72 characters maximum, imperative mood, no trailing period.
- If the commits look like Conventional Commits, keep the type/scope prefix
  in the title (e.g. "feat(auth): support OAuth2 PKCE flow").
- Prefer the INTENT of the change over mechanics.

Body rules:
- Markdown, three sections in this order:
    ## Summary
    1–3 sentences in plain prose covering WHAT changes and WHY.
    ## Changes
    Bulleted list of concrete changes (one line each). Do not dump
    commit hashes.
    ## Test plan
    Short checklist ("- [ ] …") with 2–5 items relevant to the change.
- If you notice breaking changes, add a ## Breaking changes section
  after the summary.
- Write every section in ${lang}. Keep the headings in ${lang} too
  (Résumé / Changements / Plan de test in French; Summary / Changes /
  Test plan in English).

Output rules:
- Output ONLY the JSON object, no markdown fences, no preamble, no
  trailing prose. Both fields are required strings.`;
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
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!cwd) throw new Error("Aucun repo ouvert (cwd vide).");
      if (!headBranch || !baseBranch) {
        throw new Error("Branche source ou cible manquante.");
      }
      if (headBranch === baseBranch) {
        throw new Error(
          "La branche source et la branche cible sont identiques — aucune PR possible.",
        );
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
        throw new Error(
          `Aucun commit entre ${baseBranch} et ${headBranch} — rien à décrire.`,
        );
      }
      const diffstat = clip((statRes.stdout ?? "").trim(), maxStatChars);

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(headBranch, baseBranch, commits, diffstat);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
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

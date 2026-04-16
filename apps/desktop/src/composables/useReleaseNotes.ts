import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";

/**
 * Generate Keep-a-Changelog-style markdown release notes from the
 * commits between two refs (tags or branches, e.g. `v1.2.0..HEAD` or
 * `main..release/2026.04`). Uses the configured AI provider, same
 * plumbing as commit messages and PR descriptions.
 */

export interface ReleaseNotesOptions {
  /** UI locale — drives section headings and prose. Defaults to "fr". */
  locale?: string;
  /** Max characters of commit dump kept (default 24k). */
  maxCommitsChars?: number;
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
  return `You write clean, user-facing release notes from a list of Git
commits.

Rules:
- Output strict Markdown, ready to paste into a GitHub release or a
  CHANGELOG.md. No code fences around the whole thing, no preamble
  outside the document itself.
- Structure the notes with the following sections, ONLY if non-empty:
    ## Added     — new user-facing features
    ## Changed   — improvements, renames, perf
    ## Fixed     — bug fixes
    ## Security  — CVE / auth / trust fixes
    ## Breaking changes — API / behaviour breaks (top priority)
    ## Internal  — tooling / CI / refactor with no user impact
- Each bullet is ONE line, user-centric, imperative. No commit hashes,
  no author names, no trailers.
- Merge commits, release bumps ("chore: 1.2.3"), and pure-noise
  commits ("wip", "fix typo") should be collapsed into a single
  bullet in the matching section, or dropped entirely.
- Write every heading and bullet in ${lang}. Keep the headings in
  ${lang} (Ajouté / Modifié / Corrigé / Sécurité / Changements bloquants
  / Interne in French; Added / Changed / Fixed / Security / Breaking
  changes / Internal in English).
- Start the output with a single H2 heading that includes the target
  ref (e.g. "## Release v1.3.0") — never higher than H2.
- Keep the whole output under 3000 characters.
- Do not invent features that aren't in the commit list.`;
}

function buildUserPrompt(fromRef: string, toRef: string, commits: string): string {
  return `Base ref: ${fromRef}
Target ref: ${toRef}

--- commits (${fromRef}..${toRef}, newest first) ---
${commits.trim() || "(no commits)"}

Write the release notes.`;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}

function stripMarkdownFences(raw: string): string {
  let s = raw.trim();
  const m = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (m) s = m[1].trim();
  return s;
}

/**
 * Try to find the most recent tag for a sensible default "from" value.
 * Falls back to an empty string, letting the caller prompt the user.
 */
export async function latestTag(cwd: string): Promise<string> {
  try {
    const res = await gitExec(cwd, [
      "describe", "--tags", "--abbrev=0",
    ]);
    if (res.exitCode !== 0) return "";
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastMarkdown = ref<string | null>(null);

export function useReleaseNotes() {
  const ai = useAIProvider();

  async function generate(
    cwd: string,
    fromRef: string,
    toRef: string,
    options: ReleaseNotesOptions = {},
  ): Promise<string> {
    const { locale = "fr", maxCommitsChars = 24_000 } = options;

    isGenerating.value = true;
    lastError.value = null;
    lastMarkdown.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!cwd) throw new Error("Aucun repo ouvert (cwd vide).");
      if (!fromRef.trim() || !toRef.trim()) {
        throw new Error("Les deux références (source et cible) sont requises.");
      }
      if (fromRef === toRef) {
        throw new Error(
          "Les deux références sont identiques — aucun commit à inclure.",
        );
      }

      const range = `${fromRef}..${toRef}`;
      const logRes = await gitExec(cwd, [
        "log",
        range,
        "--no-decorate",
        "--no-color",
        "--pretty=format:--- %h%n%s%n%b",
      ]);

      if (logRes.exitCode !== 0) {
        const stderr = (logRes.stderr ?? "").trim();
        throw new Error(
          stderr || `git log ${range} failed (exit ${logRes.exitCode})`,
        );
      }

      const commits = clip((logRes.stdout ?? "").trim(), maxCommitsChars);
      if (!commits) {
        throw new Error(
          `Aucun commit entre ${fromRef} et ${toRef} — rien à décrire.`,
        );
      }

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(fromRef, toRef, commits);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }
      const markdown = stripMarkdownFences(raw);
      lastMarkdown.value = markdown;
      return markdown;
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
    lastMarkdown,
    generate,
    latestTag,
  };
}

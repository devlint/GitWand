import { ref, reactive } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";
import { t } from "./useI18n";
import { getActiveTemplate } from "./useAiTemplates";
import { applyLang, DEFAULT_TEMPLATE_PROMPTS } from "./aiTemplateDefaults";


/**
 * Generate Keep-a-Changelog-style markdown release notes from the
 * commits between two refs (tags or branches, e.g. `v1.2.0..HEAD` or
 * `main..release/2026.04`). Uses the configured AI provider, same
 * plumbing as commit messages and PR descriptions.
 */

/**
 * Sentinel `from` value meaning "from the very first commit" — generate notes
 * over the entire history reachable from the target ref. Chosen to contain
 * characters that are illegal in a git ref name, so it can never collide with a
 * real branch/tag.
 */
export const FROM_PROJECT_START = "(project start)";

export interface ReleaseNotesOptions {
  /** UI locale — drives section headings and prose. Defaults to "fr". */
  locale?: string;
  /** Max characters of commit dump kept (default 24k). */
  maxCommitsChars?: number;
}

function localeToEnglishName(code: string): string {
  const map: Record<string, string> = {
    fr: "French",
    en: "English",
    es: "Spanish",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
    nl: "Dutch",
    ru: "Russian",
    ar: "Arabic",
    pl: "Polish",
    sv: "Swedish",
    da: "Danish",
    nb: "Norwegian",
  };
  return map[code] ?? localeLabels[code as SupportedLocale] ?? code;
}

function buildSystemPrompt(locale: string, firstRelease = false): string {
  const lang = localeToEnglishName(locale);

  if (firstRelease) {
    // The project has never been released. Frame this as an inaugural
    // announcement that introduces the project and showcases what it offers —
    // NOT a changelog of edits. There is no prior version to diff against.
    return `You write the announcement for a project's very FIRST release.
This project has never been released before, so there is NO previous
version to compare against. Do NOT frame anything as changes, updates,
fixes, or breaking changes — nothing is "new since last time" because
there was no last time. This is the debut.

Tone: warm, welcoming, a little proud. "Here is this project and
everything it offers." Present the features that exist today, not a
history of how they were built.

Rules:
- Output strict Markdown, ready to paste into a GitHub release. No code
  fences around the whole thing, no preamble outside the document itself.
- Start with a single H2 heading announcing the release, including the
  target ref shown below (never higher than H2), followed by ONE or two
  sentences introducing what the project is and who it's for.
- Then list what the project offers under these sections, ONLY if
  non-empty:
    ## Highlights — the headline capabilities, the reasons to care
    ## Features   — the full set of user-facing features it ships with
- Each bullet is ONE line, user-centric, written in the PRESENT tense as
  a capability the project HAS ("Resolves merge conflicts automatically",
  not "Added automatic conflict resolution"). No commit hashes, no author
  names, no trailers.
- Collapse build/CI/refactor/chore/"wip"/"fix typo" commits away
  entirely — an inaugural announcement never mentions internal plumbing.
- Do NOT include Changed, Fixed, Security, Breaking changes, or Internal
  sections. There are no deltas to report.
- Synthesize the commit list into the product's capabilities; do not
  enumerate commits. Do not invent features that aren't supported by the
  commit list.
- Write every heading and bullet in ${lang}.
- Keep the whole output under 3000 characters.`;
  }

  return applyLang(DEFAULT_TEMPLATE_PROMPTS.releaseNotes, lang);
}

function buildUserPrompt(
  fromRef: string,
  toRef: string,
  commits: string,
): string {
  // "From the project creation" covers the entire history up to the target,
  // including the initial commit — make that explicit so the model doesn't
  // treat the base as an excluded lower bound.
  if (fromRef === FROM_PROJECT_START) {
    return `Base ref: the project's initial commit (inclusive)
Target ref: ${toRef}

--- commits (entire history through ${toRef}, including the very first commit of the project, newest first) ---
${commits.trim() || "(no commits)"}

Write the release notes.`;
  }

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
 * Drop any preamble the model leaks before the document itself — e.g. a stray
 * "Release notes = document → write normal English (per rules)." line. Both
 * prompts require the output to start with an H2 heading, so anything before
 * the first Markdown heading is noise. No-op when no heading is found.
 */
function stripPreamble(s: string): string {
  const idx = s.search(/^#{1,6}\s/m);
  return idx > 0 ? s.slice(idx).trimStart() : s;
}

/**
 * Try to find the most recent tag for a sensible default "from" value.
 * Falls back to an empty string, letting the caller prompt the user.
 */
export async function latestTag(cwd: string): Promise<string> {
  try {
    const res = await gitExec(cwd, ["describe", "--tags", "--abbrev=0"]);
    if (res.exitCode !== 0) return "";
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastMarkdown = ref<string | null>(null);

/**
 * Per-repo state of the release-notes modal. Lives at module level so closing
 * the modal keeps the refs and the generated text, and a generation started
 * before closing still lands here when it finishes.
 */
export interface ReleaseNotesDraft {
  from: string;
  to: string;
  markdown: string;
  error: string | null;
}

const drafts = reactive(new Map<string, ReleaseNotesDraft>());
const generatingCwds = reactive(new Set<string>());

/** The repo's draft, created empty on first access. `from === ""` means not initialised yet. */
export function getReleaseNotesDraft(cwd: string): ReleaseNotesDraft {
  let d = drafts.get(cwd);
  if (!d) {
    drafts.set(cwd, { from: "", to: "HEAD", markdown: "", error: null });
    d = drafts.get(cwd)!; // reactive proxy
  }
  return d;
}

/** True while release notes are being generated for this repo. */
export function isGeneratingReleaseNotes(cwd: string | null | undefined): boolean {
  return !!cwd && generatingCwds.has(cwd);
}

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
    generatingCwds.add(cwd);
    lastError.value = null;
    lastMarkdown.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(t("errors.noAiProvider"));
      }
      if (!cwd) throw new Error(t("errors.noRepoOpen"));
      if (!fromRef.trim() || !toRef.trim()) {
        throw new Error(t("errors.missingRefs"));
      }
      if (fromRef === toRef) {
        throw new Error(t("errors.sameRefs"));
      }

      // "From the project creation" → every commit reachable from the target
      // ref (no lower bound). Otherwise the usual `from..to` range.
      const fromProjectStart = fromRef === FROM_PROJECT_START;
      const range = fromProjectStart ? toRef : `${fromRef}..${toRef}`;
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
        throw new Error(t("errors.noCommitsInRange", fromRef, toRef));
      }

      // A selected template replaces the default prompt — including the
      // first-release variant, so the user prompt flags that case instead.
      const template = getActiveTemplate("releaseNotes", cwd);
      const systemPrompt = template
        ? applyLang(template.systemPrompt, localeToEnglishName(locale))
        : buildSystemPrompt(locale, fromProjectStart);
      let userPrompt = buildUserPrompt(fromRef, toRef, commits);
      if (template && fromProjectStart) {
        userPrompt += "\nThis is the project's very first release: there is no previous version to compare against.";
      }

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error(t("errors.emptyAiResponse"));
      }
      const markdown = stripPreamble(stripMarkdownFences(raw));
      lastMarkdown.value = markdown;
      return markdown;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.value = msg;
      throw err;
    } finally {
      generatingCwds.delete(cwd);
      isGenerating.value = generatingCwds.size > 0;
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

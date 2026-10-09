import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import { localeLabels, type SupportedLocale } from "../locales";
import { t } from "./useI18n";
import { maskMedia, restoreMedia } from "../utils/prBodyMedia";
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

--- diffstat (${base}...${head}, i.e. since the merge base) ---
${diffstat.trim() || "(empty)"}

Write the PR description.`;
}

function buildUpdateSystemPrompt(cwd: string, locale: string): string {
  const lang = localeToEnglishName(locale);
  const template = getActiveTemplate("pr", cwd);
  return `You are a senior engineer updating the description of an existing
GitHub Pull Request so it reflects the latest state of the branch.

You will receive:
- The head branch name
- The base branch name
- The CURRENT description of the PR
- The list of commits between base..head (most recent first)
- A diffstat summary (files changed + added/deleted lines)

Rewrite the description so it accurately covers ALL the commits, including
the ones added since it was written.

Rules:
- Keep the structure, headings and tone of the current description when it
  has some. Keep any hand-written context (motivation, links, issue
  references, notes for reviewers) that is still true. Remove or correct
  statements the commits no longer support. Add what is new.
- If the current description is empty or unstructured, use these sections:
    ## Summary / ## Changes / ## Test plan
- Keep checklist items ("- [x]" / "- [ ]") with their checked state when
  they still apply.
- The current description contains placeholders like [[IMAGE_1]]. Each one
  stands for an image or video uploaded by the author. Keep EVERY
  placeholder, written exactly as given, on its own line, next to the text
  it illustrates. Never invent new placeholders and never write image URLs.
- Write in ${lang}, unless the current description is clearly written in
  another language — then keep that language.

Output rules:
- Output ONLY the new description as Markdown, no JSON, no code fences
  around the whole answer, no preamble, no trailing prose.${template ? `

The user picked a PR template. Follow its guidance on the description's
structure, sections and tone — it takes precedence over the structure of the
current description. Ignore its output-format rules (JSON, title): you still
output ONLY the description as Markdown.

--- PR template ---
${applyLang(template.systemPrompt, lang)}
--- end template ---` : ""}`;
}

function buildUpdateUserPrompt(
  head: string,
  base: string,
  currentBody: string,
  commits: string,
  diffstat: string,
): string {
  return `Head branch: ${head}
Base branch: ${base}

--- current description ---
${currentBody.trim() || "(empty)"}

--- commits (${head} not in ${base}, newest first) ---
${commits.trim() || "(no commits yet)"}

--- diffstat (${base}...${head}, i.e. since the merge base) ---
${diffstat.trim() || "(empty)"}

Write the updated PR description.`;
}

/** Strip a fence the model wrapped the whole answer in despite the rules. */
function unwrapMarkdown(raw: string): string {
  const s = raw.trim();
  const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fence ? fence[1] : s).trim();
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

/**
 * Commits + diffstat of `baseRef..headRef`, for the prompt. `baseName` /
 * `headName` are the branch names shown in errors — the refs themselves may be
 * SHAs or remote-tracking refs.
 */
async function collectRange(
  cwd: string,
  baseRef: string,
  headRef: string,
  baseName: string,
  headName: string,
  maxCommits: number,
  maxStatChars: number,
): Promise<{ commits: string; diffstat: string }> {
  const range = `${baseRef}..${headRef}`;
  // The diffstat uses the merge base (three dots): if the base branch moved on
  // since the PR branched off, `base..head` would count the base's own new
  // changes as if the PR made them. The commit list is already "in head, not
  // in base", which `..` expresses correctly.
  const statRange = `${baseRef}...${headRef}`;
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
      gitExec(cwd, ["diff", "--stat", "--no-color", statRange]),
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
    throw new Error(t("errors.noCommitsInRange", baseName, headName));
  }
  return { commits, diffstat: clip((statRes.stdout ?? "").trim(), maxStatChars) };
}

/** First candidate that names a commit in the local repo, or null. */
async function firstLocalCommit(cwd: string, candidates: string[]): Promise<string | null> {
  for (const ref of candidates) {
    if (!ref) continue;
    const res = await gitExec(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (res.exitCode === 0) return ref;
  }
  return null;
}

/** The PR fields an update needs — a subset of `PullRequestDetail`. */
export interface PrDescriptionTarget {
  number: number;
  branch: string;
  base: string;
  /** Forge-reported head commit; "" when unknown. */
  headSha: string;
  body: string;
}

/** An AI-updated body waiting for the user to review and apply it. */
export interface PendingPrDescriptionUpdate {
  cwd: string;
  number: number;
  body: string;
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastResult = ref<PrDescription | null>(null);

/**
 * Update state is module-level, like the generate state: the model may answer
 * after the user navigated to another PR, and the draft must still be there
 * when they come back. Everything is keyed by repo + PR number so a draft or
 * an error never shows on, or gets replaced by, another PR.
 */
const pendingUpdates = ref<Record<string, PendingPrDescriptionUpdate>>({});
const updateErrors = ref<Record<string, string>>({});
const updating = ref<Record<string, true>>({});

function prKey(cwd: string, number: number): string {
  return `${cwd}\u0000${number}`;
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = rec;
  return rest;
}

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

      const { commits, diffstat } = await collectRange(
        cwd, baseBranch, headBranch, baseBranch, headBranch, maxCommits, maxStatChars,
      );

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


  /**
   * Rewrite an existing PR's description so it covers the PR's latest
   * commits. Images and videos already in the body survive verbatim (see
   * `utils/prBodyMedia.ts`). The result is stored in `pendingUpdate` for the
   * user to review — nothing is written to the forge here.
   */
  async function update(
    cwd: string,
    pr: PrDescriptionTarget,
    options: PrDescriptionOptions = {},
  ): Promise<string> {
    const { locale = "fr", maxStatChars = 8_000, maxCommits = 40 } = options;

    const key = prKey(cwd, pr.number);
    updating.value = { ...updating.value, [key]: true };
    updateErrors.value = omit(updateErrors.value, key);

    try {
      if (!ai.isAvailable.value) {
        throw new Error(t("errors.noAiProvider"));
      }
      if (!cwd) throw new Error(t("errors.noRepoOpen"));
      if (!pr.branch || !pr.base) {
        throw new Error(t("errors.missingBranch"));
      }

      // The PR's own state is the remote one: prefer the forge's head SHA,
      // then the remote-tracking refs, then local branches. The local branch
      // may be stale or absent (PR from a fork, never checked out).
      const headRef = await firstLocalCommit(cwd, [pr.headSha, `origin/${pr.branch}`, pr.branch]);
      const baseRef = await firstLocalCommit(cwd, [`origin/${pr.base}`, pr.base]);
      if (!headRef || !baseRef) {
        throw new Error(t("pr.detail.aiUpdateMissingRefs", pr.base, pr.branch));
      }

      const { commits, diffstat } = await collectRange(
        cwd, baseRef, headRef, pr.base, pr.branch, maxCommits, maxStatChars,
      );

      const masked = maskMedia(pr.body ?? "");
      const raw = await ai.rawPrompt(
        buildUpdateSystemPrompt(cwd, locale),
        buildUpdateUserPrompt(pr.branch, pr.base, masked.text, commits, diffstat),
      );
      const text = unwrapMarkdown(raw ?? "");
      if (!text) {
        throw new Error(t("errors.emptyAiResponse"));
      }

      const body = restoreMedia(text, masked.media, masked.adjacentTicks);
      pendingUpdates.value = { ...pendingUpdates.value, [key]: { cwd, number: pr.number, body } };
      return body;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateErrors.value = { ...updateErrors.value, [key]: msg };
      throw err;
    } finally {
      updating.value = omit(updating.value, key);
    }
  }

  /** The AI draft waiting on this PR, if any. */
  function pendingUpdateFor(cwd: string, number: number): PendingPrDescriptionUpdate | null {
    return pendingUpdates.value[prKey(cwd, number)] ?? null;
  }

  /** The last update error of this PR, if any. */
  function updateErrorFor(cwd: string, number: number): string | null {
    return updateErrors.value[prKey(cwd, number)] ?? null;
  }

  function isUpdatingFor(cwd: string, number: number): boolean {
    return prKey(cwd, number) in updating.value;
  }

  /** Replace the body of an open draft (the user edited it before applying). */
  function setPendingBody(cwd: string, number: number, body: string) {
    const d = pendingUpdateFor(cwd, number);
    if (d) pendingUpdates.value = { ...pendingUpdates.value, [prKey(cwd, number)]: { ...d, body } };
  }

  function clearPendingUpdate(cwd: string, number: number) {
    const key = prKey(cwd, number);
    pendingUpdates.value = omit(pendingUpdates.value, key);
    updateErrors.value = omit(updateErrors.value, key);
  }

  return {
    isGenerating,
    lastError,
    lastResult,
    generate,
    update,
    pendingUpdateFor,
    updateErrorFor,
    isUpdatingFor,
    setPendingBody,
    clearPendingUpdate,
  };
}

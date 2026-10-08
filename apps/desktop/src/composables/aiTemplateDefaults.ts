/**
 * aiTemplateDefaults — the built-in system prompts behind every AI template kind.
 *
 * Single source for both the generators (useCommitMessage, usePrDescription,
 * useReleaseNotes) and the read-only "Default" entries shown in Settings → AI
 * Templates, so what the user views is exactly what the model receives.
 *
 * Every prompt uses `${lang}` as a language placeholder, substituted with
 * {@link applyLang} at generation time.
 */

import type { AiPromptPreset } from "./useSettings";

export type AiTemplateKind = "commit" | "pr" | "releaseNotes";

/** Id of the implicit, read-only Default template of every kind. */
export const DEFAULT_TEMPLATE_ID = "__builtin_default";

/** Prefix shared by every read-only built-in template id. */
export const BUILTIN_PREFIX = "__builtin_";

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

/** Replace every `${lang}` placeholder with the resolved language name. */
export function applyLang(prompt: string, lang: string): string {
  return prompt.replace(/\$\{lang\}/g, lang);
}

const DEFAULT_COMMIT_PROMPT = `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
   Valid types: feat, fix, refactor, perf, docs, test, chore, build, ci, style.
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. After the subject, leave a blank line, then optionally add a short body (1-3 lines)
   explaining *why* the change was made. Skip the body for trivial changes.
4. Write in \${lang}.
5. Do not include trailers (Co-Authored-By, Signed-off-by, Reviewed-by…) — the user controls those via the GitWand trailer checkboxes.
6. Never wrap your answer in code fences or add explanations — output ONLY the
   raw commit message, ready to be passed to \`git commit -m\`.`;

const DEFAULT_PR_PROMPT = `You are a senior engineer drafting a GitHub Pull Request description.

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
- Write every section in \${lang}. Keep the headings in \${lang} too
  (Résumé / Changements / Plan de test in French; Summary / Changes /
  Test plan in English).

Output rules:
- Output ONLY the JSON object, no markdown fences, no preamble, no
  trailing prose. Both fields are required strings.`;

const DEFAULT_RELEASE_NOTES_PROMPT = `You write clean, user-facing release notes from a list of Git
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
- Write every heading and bullet in \${lang}. Keep the headings in
  \${lang} (Ajouté / Modifié / Corrigé / Sécurité / Changements bloquants
  / Interne in French; Added / Changed / Fixed / Security / Breaking
  changes / Internal in English).
- Start the output with a single H2 heading that includes the target
  ref (e.g. "## Release v1.3.0") — never higher than H2.
- Keep the whole output under 3000 characters.
- Do not invent features that aren't in the commit list.`;

/** Default system prompt of each template kind (with `${lang}` placeholders). */
export const DEFAULT_TEMPLATE_PROMPTS: Readonly<Record<AiTemplateKind, string>> = {
  commit: DEFAULT_COMMIT_PROMPT,
  pr: DEFAULT_PR_PROMPT,
  releaseNotes: DEFAULT_RELEASE_NOTES_PROMPT,
};

/**
 * Header that introduced the free-form rules of a pre-AI-Templates release
 * note template. Kept so a migrated legacy template sends the model the exact
 * prompt it used to.
 */
export const LEGACY_RELEASE_NOTES_RULES_HEADER = "Additional instructions and custom rules:";

// ─── Built-in presets ─────────────────────────────────────────────────────────

// Note: the Default template is NOT part of this list. It is reachable via the
// "Default" menu entry (activate(null)) and exposed separately as
// DEFAULT_TEMPLATE_PROMPTS.commit, so listing it here would duplicate it.
export const BUILTIN_PRESETS: ReadonlyArray<AiPromptPreset> = [
  {
    id: "__builtin_concise",
    name: "Concise",
    description: "One-liner only, no body.",
    systemPrompt: `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
2. Subject line MUST be 60 characters or less, imperative mood, no trailing period.
3. Output ONLY the subject line — no body, no blank lines.
4. Write in \${lang}.
5. Never wrap your answer in code fences — output ONLY the raw subject line.`,
  },
  {
    id: "__builtin_detailed",
    name: "Detailed",
    description: "Conventional Commits with a mandatory WHY/WHAT body.",
    systemPrompt: `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. ALWAYS add a body (2-5 lines) separated from the subject by a blank line.
   The body MUST explain: (a) WHY the change was made, (b) WHAT it impacts.
4. Write in \${lang}.
5. Do not include trailers.
6. Never wrap your answer in code fences — output ONLY the raw commit message.`,
  },
  {
    id: "__builtin_emoji",
    name: "Emoji",
    description: "Gitmoji-style prefix based on change type.",
    systemPrompt: `You are a senior software engineer writing a Git commit message.

Rules:
1. Start the subject line with a single relevant gitmoji, then a space.
   Examples: ✨ new feature, 🐛 bug fix, ♻️ refactor, 📝 docs, ⚡️ perf, 🔧 config.
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. After the subject, optionally add a short body (1-3 lines) explaining why.
4. Write in \${lang}.
5. Do not include trailers.
6. Never wrap your answer in code fences — output ONLY the raw commit message.`,
  },
];

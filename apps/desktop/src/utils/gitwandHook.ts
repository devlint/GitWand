/**
 * v3.7.0 (Task 6) — Single, composable GitWand-managed pre-commit hook script.
 *
 * `.git/hooks/pre-commit` can hold exactly one script. Before this module, the v3.5.0 secrets
 * hook (`utils/secretsHook.ts`) unconditionally OWNED that path via
 * `gitHookCreate(cwd, "pre-commit", buildSecretsHookScript())`, which overwrites whatever is
 * there. A second, independent "Commit Review" reminder hook cannot coexist at the same path
 * without one clobbering the other — so this module builds ONE script that can carry either or
 * both sections, each marked by parseable boundary comments.
 *
 * The secrets section, when present, is BYTE-IDENTICAL to the shipped v3.5.0
 * `buildSecretsHookScript()` invocation (`npx --no-install @gitwand/cli scan --staged --strict
 * --json || { ... exit 1 }`) — this is a regression guard on a shipped, enforcing feature; do not
 * change that invocation without updating the CLI's `scan` command in lockstep.
 *
 * The review section is WARN-ONLY: review state lives in the app's `localStorage` (the
 * established per-repo client-state pattern — see `usePrCache`/`useAiTasks`), which a shell hook
 * has no way to read. It always exits 0; it only prints a reminder that GitWand's Commit Review
 * did not run for a commit made from the terminal. Making this enforcing would need either an
 * on-disk state file (a new Tauri command — `.git/…` writes must go through `safe_repo_path`,
 * which rejects a linked worktree's real gitdir) or a real `@gitwand/cli review` subcommand — both
 * explicitly out of scope for this PR (plan decision D10).
 */
import { SECRETS_HOOK_MARKER, isSecretsHookScript } from "./secretsHook";

export const GITWAND_HOOK_MARKER = "# gitwand-hook v2";

export interface HookSections {
  secrets: boolean;
  review: boolean;
}

const SECRETS_SECTION_START = "# >>> gitwand:secrets";
const SECRETS_SECTION_END = "# <<< gitwand:secrets";
const REVIEW_SECTION_START = "# >>> gitwand:review";
const REVIEW_SECTION_END = "# <<< gitwand:review";

/**
 * Regression guard: byte-identical to `secretsHook.ts`'s `buildSecretsHookScript()` body (minus
 * its own shebang/marker lines, which the v2 composable script owns instead).
 */
function secretsSectionLines(): string[] {
  return [
    SECRETS_SECTION_START,
    "npx --no-install @gitwand/cli scan --staged --strict --json || {",
    '  echo "GitWand: potential secrets in staged changes (see above). Commit blocked."',
    '  echo "Bypass once with: git commit --no-verify"',
    "  exit 1",
    "}",
    SECRETS_SECTION_END,
  ];
}

/**
 * Warn-only, never exits non-zero, so a commit is never blocked by this section. LOW fix
 * (PR3 verifier pass): the reminder used to claim "this commit was made from the terminal",
 * but the hook fires for any `git commit` that reaches this script, including a commit made
 * from GitWand's own GUI without `--no-verify` (harmless there since a successful GUI commit
 * discards hook stdout, but the wording was still factually wrong). Worded generically instead
 * of assuming the commit's origin.
 */
function reviewSectionLines(): string[] {
  return [
    REVIEW_SECTION_START,
    "# GitWand Commit Review is warn-only: review state lives in the app's local storage,",
    "# which a shell hook cannot read. This section never blocks the commit.",
    'echo "GitWand: commit review did not run for this commit."',
    REVIEW_SECTION_END,
  ];
}

/** Builds the composable pre-commit hook script installed via `gitHookCreate(cwd, "pre-commit", ...)`. */
export function buildGitwandHookScript(sections: HookSections): string {
  const lines: string[] = ["#!/usr/bin/env bash", `${GITWAND_HOOK_MARKER} — do not edit; managed by GitWand`];
  if (sections.secrets) lines.push(...secretsSectionLines());
  if (sections.review) lines.push(...reviewSectionLines());
  lines.push("");
  return lines.join("\n");
}

/**
 * Detects which GitWand-managed sections are installed in `content`.
 *
 * - A v2 composable script (has `GITWAND_HOOK_MARKER`): sections reported per the presence of
 *   their boundary comments.
 * - A v1 secrets-only script (`SECRETS_HOOK_MARKER`, no v2 marker) — migration detection only:
 *   reported as `{ secrets: true, review: false }`.
 * - Anything else (a foreign/unrelated hook, or no hook at all): `null`.
 */
export function parseGitwandHookSections(content: string): HookSections | null {
  if (content.includes(GITWAND_HOOK_MARKER)) {
    return {
      secrets: content.includes(SECRETS_SECTION_START) && content.includes(SECRETS_SECTION_END),
      review: content.includes(REVIEW_SECTION_START) && content.includes(REVIEW_SECTION_END),
    };
  }

  // Migration detection only — see `secretsHook.ts`'s deprecation note. An installed v1 script
  // must still be recognized as "secrets on, review off" until it's reinstalled as v2.
  if (isSecretsHookScript(content)) {
    return { secrets: true, review: false };
  }

  return null;
}

// Re-exported so call sites that only need to detect a legacy v1 script don't have to import
// from both modules.
export { SECRETS_HOOK_MARKER };

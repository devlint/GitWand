/**
 * useAiExtraContext — free-form context the user adds to an AI template's
 * prompt from the "ctx" segment of an AI split button (PR description,
 * release notes).
 *
 * Kept per scope and per repo, in memory only: it describes the change at hand
 * ("this PR also closes #12", "skip the internal refactors"), not a lasting
 * preference, so it lives for the session and is never persisted. The scope
 * names the generator ("pr-create", "pr-update:42", "releaseNotes"), so a
 * PR's update context never leaks into another PR or into PR creation.
 */

import { computed, reactive } from "vue";
import { normaliseCwd } from "./useSettings";

const contexts = reactive(new Map<string, string>());

function key(scope: string, cwd: string): string {
  return `${scope}@${normaliseCwd(cwd)}`;
}

/** The context set for `scope` in `cwd`, or "" when none. */
export function getAiExtraContext(scope: string, cwd: string): string {
  return contexts.get(key(scope, cwd)) ?? "";
}

/** Set (or, with blank text, clear) the context of `scope` in `cwd`. */
export function setAiExtraContext(scope: string, cwd: string, text: string): void {
  if (text.trim()) contexts.set(key(scope, cwd), text);
  else contexts.delete(key(scope, cwd));
}

export function useAiExtraContext(getScope: () => string, getCwd: () => string) {
  const context = computed(() => getAiExtraContext(getScope(), getCwd()));
  return {
    context,
    setContext: (text: string) => setAiExtraContext(getScope(), getCwd(), text),
  };
}

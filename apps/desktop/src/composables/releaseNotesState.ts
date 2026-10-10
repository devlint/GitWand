import { reactive } from "vue";
import { normaliseCwd } from "./useSettings";

/*
 * Release-notes state, apart from the generator in useReleaseNotes.ts so the
 * always-mounted header, dashboard and tags panel can read the generating flag
 * without pulling the generator (prompts, git log handling) into the main
 * bundle.
 */

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
  const key = normaliseCwd(cwd);
  if (!drafts.has(key)) drafts.set(key, { from: "", to: "HEAD", markdown: "", error: null });
  return drafts.get(key)!;
}

/** True while the repo's draft is being generated. */
export function isGeneratingReleaseNotes(cwd: string | null | undefined): boolean {
  return !!cwd && generatingCwds.has(normaliseCwd(cwd));
}

/** For useReleaseNotes only: the in-flight set its generator lights. */
export { generatingCwds as releaseNotesGeneratingCwds };

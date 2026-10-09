/**
 * Remote-image consent outside the global setting.
 *
 * Remote images in rendered markdown are withheld by default (see
 * `useSafeHtml`). Two narrower ways to accept them:
 *
 * - **README, per project** — remembered in `remoteImagesByRepo`, so the
 *   project's README keeps showing its badges and screenshots.
 * - **PR, for the PR being read** — not remembered: a PR's description and
 *   comments are written by other people, and accepting one PR's images says
 *   nothing about the next one. `PR_REMOTE_IMAGES_KEY` shares that choice from
 *   the PR detail view with the inline comment threads it renders.
 */
import { computed, reactive, type InjectionKey, type Ref } from "vue";
import { loadSettings, normaliseCwd, refreshSettings, saveSettings, useSettings } from "./useSettings";
import { hasBlockedRemoteImages, renderMarkdown } from "./useSafeHtml";

/** Provided by the PR detail view: whether the user accepted this PR's images. */
export const PR_REMOTE_IMAGES_KEY: InjectionKey<Ref<boolean>> = Symbol("prRemoteImages");

/**
 * Projects accepted during this session, by `normaliseCwd` key. Read by
 * `allowed` alongside the persisted setting, so the README updates on the
 * click itself rather than through the settings reload — which, in a dev
 * session whose modules were hot-reloaded, can land on another copy of the
 * settings ref than the one the README reads.
 */
const acceptedThisSession = reactive(new Set<string>());

/** README consent for the project at `cwd`. */
export function useRepoRemoteImages(cwd: Ref<string | null | undefined>) {
  const { settings } = useSettings();

  /** True when this project's README may load remote images. */
  const allowed = computed(() => {
    if (settings.value.allowRemoteImages) return true;
    const path = cwd.value;
    if (!path) return false;
    const key = normaliseCwd(path);
    return acceptedThisSession.has(key) || settings.value.remoteImagesByRepo?.[key] === true;
  });

  /** Remember the consent for this project. */
  function allowForRepo(): void {
    const path = cwd.value;
    if (!path) return;
    const key = normaliseCwd(path);
    acceptedThisSession.add(key);
    const s = loadSettings();
    s.remoteImagesByRepo = { ...(s.remoteImagesByRepo ?? {}), [key]: true };
    saveSettings(s);
    refreshSettings();
  }

  return { allowed, allowForRepo };
}

/**
 * Comment body → whether rendering it withholds a remote image. Rendering is
 * markdown-it + DOMPurify, too costly to redo for every comment of the file
 * on each recompute; the answer depends on the body alone (rendered without
 * consent) and the global setting, so it is cached by those. Bounded: dropped wholesale when full.
 */
const withheldByBody = new Map<string, boolean>();
const WITHHELD_CACHE_MAX = 500;

function bodyWithholdsImages(body: string): boolean {
  // The global setting changes the answer: part of the key (and read through
  // the reactive settings, so a computed using this re-runs on toggle).
  const global = useSettings().settings.value.allowRemoteImages === true;
  const key = `${global ? 1 : 0}\u0000${body}`;
  let v = withheldByBody.get(key);
  if (v === undefined) {
    v = hasBlockedRemoteImages(renderMarkdown(body, { allowRemoteImages: false }));
    if (withheldByBody.size >= WITHHELD_CACHE_MAX) withheldByBody.clear();
    withheldByBody.set(key, v);
  }
  return v;
}

/**
 * Whether any of `comments` has remote images withheld while the PR's images
 * are not `shown` — the cue for the "Show images" button above the inline
 * review threads, which render through PrCommentThread and follow
 * `PR_REMOTE_IMAGES_KEY`.
 */
export function commentsWithheldImages(comments: readonly { body: string }[], shown: boolean): boolean {
  if (shown) return false;
  return comments.some((c) => bodyWithholdsImages(c.body ?? ""));
}

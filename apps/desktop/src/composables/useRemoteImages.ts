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
import { computed, type InjectionKey, type Ref } from "vue";
import { loadSettings, normaliseCwd, refreshSettings, saveSettings, useSettings } from "./useSettings";

/** Provided by the PR detail view: whether the user accepted this PR's images. */
export const PR_REMOTE_IMAGES_KEY: InjectionKey<Ref<boolean>> = Symbol("prRemoteImages");

/** README consent for the project at `cwd`. */
export function useRepoRemoteImages(cwd: Ref<string | null | undefined>) {
  const { settings } = useSettings();

  /** True when this project's README may load remote images. */
  const allowed = computed(() => {
    if (settings.value.allowRemoteImages) return true;
    const path = cwd.value;
    return !!path && settings.value.remoteImagesByRepo?.[normaliseCwd(path)] === true;
  });

  /** Remember the consent for this project. */
  function allowForRepo(): void {
    const path = cwd.value;
    if (!path) return;
    const s = loadSettings();
    s.remoteImagesByRepo = { ...(s.remoteImagesByRepo ?? {}), [normaliseCwd(path)]: true };
    saveSettings(s);
    refreshSettings();
  }

  return { allowed, allowForRepo };
}

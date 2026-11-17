/**
 * Signed URLs for the GitHub attachments of the PR being read (#302).
 *
 * A private repository answers 404 to the webview for the
 * `github.com/user-attachments/assets/<uuid>` URLs its markdown contains; the
 * API hands out signed equivalents that work for about five minutes
 * (`ghPrAttachmentUrls`). This loads them when the PR's bodies reference an
 * attachment, and gives the renderer a `resolveImage` that swaps them in.
 *
 * Without a signed URL (public repository before the fetch lands, a failed
 * fetch, no GitHub account) the original URL is kept: on a public repository
 * it works as is. A signed URL past its expiry is not used — the image would
 * not load — and triggers one refetch; the render that follows picks up the
 * new URLs. No timer: an image already on screen stays loaded after its URL
 * expires, so there is nothing to refresh until something renders again.
 */
import { computed, shallowRef, watch, type InjectionKey, type Ref } from "vue";
import { ghPrAttachmentUrls } from "../utils/backend";
import {
  attachmentKey,
  attachmentKeysIn,
  indexSignedAttachments,
  type SignedAttachment,
} from "../utils/githubAttachments";

/** Provided by the PR detail view for the inline comment threads it renders. */
export const PR_ATTACHMENTS_KEY: InjectionKey<(src: string) => string | null> = Symbol("prAttachments");

/** A signed URL this close to its expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 15_000;
/** After a failed fetch, wait this long before the next one, so it does not loop. */
const RETRY_GAP_MS = 30_000;

export function usePrAttachments(opts: {
  cwd: Ref<string>;
  number: Ref<number | null | undefined>;
  /** False for other forges: only GitHub has these attachments. */
  enabled: Ref<boolean>;
  /** Every markdown body of the PR that may reference an attachment. */
  bodies: Ref<readonly (string | null | undefined)[]>;
  /** Clock, for tests. */
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const signed = shallowRef<Map<string, SignedAttachment>>(new Map());
  let prKey = "";
  let inFlight: Promise<void> | null = null;
  let lastFailure = -Infinity;

  /** Attachment keys the bodies reference, as a stable string for the watcher. */
  const wanted = computed(() => {
    if (!opts.enabled.value) return "";
    const keys = new Set<string>();
    for (const b of opts.bodies.value) for (const k of attachmentKeysIn(b)) keys.add(k);
    return [...keys].sort().join(",");
  });

  function load(): void {
    const cwd = opts.cwd.value;
    const n = opts.number.value;
    if (!cwd || n == null || inFlight || now() - lastFailure < RETRY_GAP_MS) return;
    const key = `${cwd}#${n}`;
    inFlight = ghPrAttachmentUrls(cwd, n)
      .then((urls) => {
        if (key === prKey) signed.value = indexSignedAttachments(urls, now());
      })
      .catch(() => {
        // Keep the original URLs: they work on a public repository.
        if (key === prKey) lastFailure = now();
      })
      .finally(() => {
        inFlight = null;
      });
  }

  watch(
    [() => opts.cwd.value, () => opts.number.value, wanted],
    ([cwd, n, keys]) => {
      const key = `${cwd}#${n}`;
      if (key !== prKey) {
        prKey = key;
        signed.value = new Map();
        lastFailure = -Infinity;
      }
      if (!keys) return;
      const t = now();
      const missing = keys.split(",").some((k) => {
        const e = signed.value.get(k);
        return !e || e.expiresAt - EXPIRY_MARGIN_MS <= t;
      });
      if (missing) load();
    },
    { immediate: true },
  );

  /** `resolveImage` for `renderMarkdown`: the live signed URL of `src`, if any. */
  function resolveImage(src: string): string | null {
    const k = attachmentKey(src);
    if (!k) return null;
    const e = signed.value.get(k); // reactive read: renders re-run when URLs arrive
    if (!e) return null;
    if (e.expiresAt - EXPIRY_MARGIN_MS <= now()) {
      queueMicrotask(load);
      return null;
    }
    return e.url;
  }

  return { resolveImage, signed };
}

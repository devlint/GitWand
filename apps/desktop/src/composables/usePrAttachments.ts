/**
 * Signed URLs for the GitHub attachments of the PR being read (#302).
 *
 * A private repository answers 404 to the webview for the
 * `github.com/user-attachments/assets/<uuid>` URLs its markdown contains; the
 * API hands out signed equivalents that work for about five minutes
 * (`ghPrAttachmentUrls`, five or six API calls, which also says whether the
 * repository is private). `resolveImage` swaps them in — for a private
 * repository only: a public one serves the originals, which never expire,
 * though GitHub signs its attachments too.
 *
 * They are fetched only when needed:
 * - an attachment image fails to load (`onImageError`, a capture listener on
 *   the view) in a repository not known to be public — the first PR of a
 *   private one, or a signed URL that expired;
 * - a render meets an expired signed URL;
 * - a PR of a repository known to be private references an attachment not
 *   fetched yet — up front, so its images do not fail first.
 * A public repository's attachments cost nothing while they load, and one
 * fetch at most when one fails (a deleted file): the answer says public.
 *
 * No clock-driven refresh: new URLs change the HTML, so every fetch
 * re-renders the PR's bodies with attachments, collapsing what the reader
 * opened — acceptable when an image is broken anyway, not every five minutes
 * for nothing. An image already on screen stays loaded after its URL expires;
 * one re-created later from cached HTML fails, and that failure fetches
 * fresh URLs. A failed fetch is retried a few times with a growing delay:
 * images that already failed do not fire `error` again.
 *
 * Without a signed URL (before the fetch lands, a failed fetch, no GitHub
 * account) the original URL is kept. An expired one stays in use until its
 * replacement arrives.
 */
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type InjectionKey, type Ref } from "vue";
import { ghPrAttachmentUrls } from "../utils/backend";
import {
  attachmentKey,
  attachmentKeysIn,
  indexSignedAttachments,
  type SignedAttachment,
} from "../utils/githubAttachments";

/** Image resolver for the inline threads; undefined when the PR is not on GitHub. */
export type ResolveImage = (src: string) => string | null;
/** Provided by the PR detail view for the inline comment threads it renders. */
export const PR_ATTACHMENTS_KEY: InjectionKey<Ref<ResolveImage | undefined>> = Symbol("prAttachments");

/**
 * Minimum gap after a failed fetch, and between two fetches triggered by
 * failing images or expired URLs, so neither can loop.
 */
const FETCH_GAP_MS = 30_000;
/** A signed URL this close to its expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 15_000;
/** Retries of a failing fetch (30 s, 1 min, 2 min, 4 min), then it waits for the next trigger. */
const MAX_RETRIES = 4;

/** Repository visibility learned this session, by cwd. */
const visibility = new Map<string, "private" | "public">();

/** For tests: forget what was learned about repositories. */
export function _resetRepoVisibility(): void {
  visibility.clear();
}

export function usePrAttachments(opts: {
  cwd: Ref<string>;
  number: Ref<number | null | undefined>;
  /** False for other forges: only GitHub has these attachments. */
  enabled: Ref<boolean>;
  /** Every stored markdown body of the PR that may reference an attachment. */
  bodies: Ref<readonly (string | null | undefined)[]>;
  /** Clock, for tests. */
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const signed = shallowRef<Map<string, SignedAttachment>>(new Map());
  /** The repository is private: signed URLs replace the originals. */
  const isPrivate = shallowRef(false);
  let prKey = "";
  let inFlight = false;
  /** The PR (`prKey`) a refresh was asked for while a fetch was running. */
  let pendingRefresh: string | null = null;
  let lastFailure = -Infinity;
  let lastRefresh = -Infinity;
  /**
   * Keys the bodies referenced when a fetch succeeded. One GitHub did not
   * return (past the first page of comments, a file that is not an image) is
   * not fetched again for being new — only if its image fails.
   */
  let asked = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  /** Attachment keys the bodies reference, as a stable string for the watcher. */
  const wanted = computed(() => {
    if (!opts.enabled.value) return "";
    const keys = new Set<string>();
    for (const b of opts.bodies.value) for (const k of attachmentKeysIn(b)) keys.add(k);
    return [...keys].sort().join(",");
  });
  const wantedKeys = () => (wanted.value ? wanted.value.split(",") : []);

  /** `retry`: from the retry timer, which already waited out the failure gap. */
  function load(refresh: boolean, retry = false): void {
    const cwd = opts.cwd.value;
    const n = opts.number.value;
    const keys = wantedKeys();
    if (!cwd || n == null || !keys.length) return;
    if (inFlight) {
      if (refresh) pendingRefresh = prKey;
      return;
    }
    if (!retry && now() - lastFailure < FETCH_GAP_MS) return;
    inFlight = true;
    const key = `${cwd}#${n}`;
    const sentAt = now();
    ghPrAttachmentUrls(cwd, n)
      .then((res) => {
        if (key !== prKey) return;
        retries = 0;
        visibility.set(cwd, res.private ? "private" : "public");
        isPrivate.value = res.private;
        // Merged, not replaced: an attachment whose endpoint failed this time
        // keeps the URL it had.
        const next = new Map(signed.value);
        for (const [k, v] of indexSignedAttachments(res.urls, sentAt)) next.set(k, v);
        signed.value = next;
        for (const k of keys) asked.add(k);
      })
      .catch(() => {
        if (key !== prKey) return;
        lastFailure = now();
        // Images that failed will not say so again: retry a few times, with a
        // growing delay, then wait for the next image error or body change.
        if (retries >= MAX_RETRIES) return;
        const delay = FETCH_GAP_MS * 2 ** retries;
        retries++;
        clearRetry();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (key === prKey) load(true, true);
        }, delay);
      })
      .finally(() => {
        inFlight = false;
        // Asked for by the PR now shown — possibly another than this fetch's.
        const again = pendingRefresh === prKey;
        pendingRefresh = null;
        // Bodies or the PR may have changed while this ran.
        if (again) load(true);
        else check();
      });
  }

  /** Up front, in a repository known to be private: fetch for attachments not asked for yet. */
  function check(): void {
    if (!isPrivate.value) return;
    if (wantedKeys().some((k) => !signed.value.has(k) && !asked.has(k))) load(false);
  }

  /** Fetch again because an image failed or a URL expired — at most once per gap. */
  function refresh(): void {
    if (!opts.enabled.value || now() - lastRefresh < FETCH_GAP_MS) return;
    // During a failure gap the retry timer covers it: keep the slot.
    if (now() - lastFailure < FETCH_GAP_MS) return;
    lastRefresh = now();
    load(true);
  }

  watch(
    [() => opts.cwd.value, () => opts.number.value, wanted],
    ([cwd, n]) => {
      const key = `${cwd}#${n}`;
      if (key !== prKey) {
        prKey = key;
        signed.value = new Map();
        isPrivate.value = visibility.get(cwd) === "private";
        asked = new Set();
        lastFailure = -Infinity;
        lastRefresh = -Infinity;
        retries = 0;
        clearRetry();
      }
      check();
    },
    { immediate: true },
  );

  if (getCurrentScope()) onScopeDispose(clearRetry);

  /**
   * `error` listener, in the capture phase (the event does not bubble), on
   * the element holding the PR's rendered bodies.
   */
  function onImageError(e: Event): void {
    const el = e.target as Element | null;
    if (el?.tagName !== "IMG") return;
    const src = el.getAttribute("src");
    if (!src || !attachmentKey(src)) return;
    // A public repository serves its attachments: a failure there (a deleted
    // file, the network) is not one signed URLs would fix.
    if (visibility.get(opts.cwd.value) === "public") return;
    refresh();
  }

  /** `resolveImage` for `renderMarkdown`: the signed URL of `src`, if any. */
  function resolveImage(src: string): string | null {
    // Pure check first: only bodies with attachments depend on the map.
    const k = attachmentKey(src);
    if (!k) return null;
    // Reactive reads: renders re-run when new URLs arrive.
    const map = signed.value;
    if (!isPrivate.value) return null;
    const e = map.get(k);
    if (!e) return null;
    if (e.expiresAt - EXPIRY_MARGIN_MS <= now()) queueMicrotask(refresh);
    return e.url;
  }

  /**
   * The URL to show for `url` now: an attachment's current signed URL, for
   * a value kept outside the rendered HTML (the full-screen viewer).
   */
  function currentUrl(url: string): string {
    return resolveImage(url) ?? url;
  }

  return { resolveImage, currentUrl, onImageError, signed };
}

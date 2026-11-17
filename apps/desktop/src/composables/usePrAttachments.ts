/**
 * Signed URLs for the GitHub attachments of the PR being read (#302).
 *
 * A private repository answers 404 to the webview for the
 * `github.com/user-attachments/assets/<uuid>` URLs its markdown contains; the
 * API hands out signed equivalents that work for about five minutes
 * (`ghPrAttachmentUrls`, five REST calls). `resolveImage` swaps them in.
 *
 * They are fetched only when needed:
 * - an attachment image fails to load (`onImageError`, a capture listener on
 *   the view): the repository is private, or a signed URL expired. On a
 *   public repository the original URL loads and nothing is fetched;
 * - a render meets an expired signed URL;
 * - a PR of a repository that already needed it this session (`signingRepos`)
 *   references an attachment not fetched yet — up front, so its images do not
 *   fail first.
 *
 * No timer: refreshing on a clock would re-render every body of the PR (the
 * new URLs change the HTML), collapsing what the reader opened. An image
 * already on screen stays loaded after its URL expires; one re-created later
 * from cached HTML fails, and that failure fetches fresh URLs.
 *
 * Without a signed URL (before the fetch lands, a failed fetch, no GitHub
 * account) the original URL is kept. An expired one stays in use until its
 * replacement arrives: a private repository serves neither, and the expired
 * one at least keeps the request on the right host.
 */
import { computed, shallowRef, watch, type InjectionKey, type Ref } from "vue";
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

/** Repositories (cwd) whose attachments needed signed URLs during this session. */
const signingRepos = new Set<string>();

/** For tests: forget which repositories needed signed URLs. */
export function _resetSigningRepos(): void {
  signingRepos.clear();
}

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
  let inFlight = false;
  /** A refresh was asked for while a fetch was running. */
  let pendingRefresh = false;
  let lastFailure = -Infinity;
  let lastRefresh = -Infinity;
  /**
   * Keys the bodies referenced when a fetch succeeded. One GitHub did not
   * return (past the first page of comments, a file that is not an image) is
   * not fetched again for being new — only if its image fails.
   */
  let asked = new Set<string>();

  /** Attachment keys the bodies reference, as a stable string for the watcher. */
  const wanted = computed(() => {
    if (!opts.enabled.value) return "";
    const keys = new Set<string>();
    for (const b of opts.bodies.value) for (const k of attachmentKeysIn(b)) keys.add(k);
    return [...keys].sort().join(",");
  });
  const wantedKeys = () => (wanted.value ? wanted.value.split(",") : []);

  function load(refresh: boolean): void {
    const cwd = opts.cwd.value;
    const n = opts.number.value;
    const keys = wantedKeys();
    if (!cwd || n == null || !keys.length) return;
    if (inFlight) {
      if (refresh) pendingRefresh = true;
      return;
    }
    if (now() - lastFailure < FETCH_GAP_MS) return;
    inFlight = true;
    const key = `${cwd}#${n}`;
    const sentAt = now();
    ghPrAttachmentUrls(cwd, n)
      .then((urls) => {
        if (key !== prKey) return;
        // Merged, not replaced: an attachment whose endpoint failed this time
        // keeps the URL it had.
        const next = new Map(signed.value);
        for (const [k, v] of indexSignedAttachments(urls, sentAt)) next.set(k, v);
        signed.value = next;
        for (const k of keys) asked.add(k);
      })
      .catch(() => {
        if (key === prKey) lastFailure = now();
      })
      .finally(() => {
        inFlight = false;
        const again = pendingRefresh && key === prKey;
        pendingRefresh = false;
        // Bodies or the PR may have changed while this ran.
        if (again) load(true);
        else check();
      });
  }

  /** Up front, for a repository known to need it: fetch for attachments not asked for yet. */
  function check(): void {
    if (!signingRepos.has(opts.cwd.value)) return;
    if (wantedKeys().some((k) => !signed.value.has(k) && !asked.has(k))) load(false);
  }

  /** Fetch again because an image failed or a URL expired — at most once per gap. */
  function refresh(): void {
    if (!opts.enabled.value || now() - lastRefresh < FETCH_GAP_MS) return;
    lastRefresh = now();
    signingRepos.add(opts.cwd.value);
    load(true);
  }

  watch(
    [() => opts.cwd.value, () => opts.number.value, wanted],
    ([cwd, n]) => {
      const key = `${cwd}#${n}`;
      if (key !== prKey) {
        prKey = key;
        signed.value = new Map();
        asked = new Set();
        lastFailure = -Infinity;
        lastRefresh = -Infinity;
        pendingRefresh = false;
      }
      check();
    },
    { immediate: true },
  );

  /**
   * `error` listener, in the capture phase (the event does not bubble), on
   * the element holding the PR's rendered bodies.
   */
  function onImageError(e: Event): void {
    const el = e.target as Element | null;
    if (el?.tagName !== "IMG") return;
    const src = el.getAttribute("src");
    if (src && attachmentKey(src)) refresh();
  }

  /** `resolveImage` for `renderMarkdown`: the signed URL of `src`, if any. */
  function resolveImage(src: string): string | null {
    const k = attachmentKey(src);
    if (!k) return null;
    // Reactive read: renders re-run when new URLs arrive.
    const e = signed.value.get(k);
    if (!e) return null;
    if (e.expiresAt - EXPIRY_MARGIN_MS <= now()) queueMicrotask(refresh);
    return e.url;
  }

  return { resolveImage, onImageError, signed };
}

/**
 * Signed URLs for the GitHub attachments of the PR being read (#302).
 *
 * A private repository answers 404 to the webview for the
 * `github.com/user-attachments/assets/<uuid>` URLs its markdown contains; the
 * API hands out signed equivalents that work for about five minutes
 * (`ghPrAttachmentUrls`, five API calls, which also says whether the PR's
 * repository is private). `resolveImage` swaps them in — for a private
 * repository only: a public one serves the originals, which never expire,
 * though GitHub signs its attachments too.
 *
 * Fetches happen on failure only — no clock, no render-driven refresh: new
 * URLs change the HTML, so every fetch re-renders the PR's bodies with
 * attachments, collapsing what the reader opened. That is acceptable when an
 * image is broken, not every few minutes for nothing.
 * - An attachment image fails to load (`onImageError`, a capture listener on
 *   the view) and a fetch can fix it: an original URL with no signed URL yet,
 *   or a signed URL that expired or was superseded. A file GitHub did not sign
 *   (deleted), a current signed URL, or any attachment of a PR found public
 *   triggers nothing, so a broken image re-created by each re-render does not
 *   loop. An image on screen stays loaded after its URL expires; one
 *   re-created later from cached HTML fails, and that failure fetches.
 * - Up front, for attachments not fetched yet, in a checkout found private
 *   earlier this session — so its next PRs' images do not fail first.
 * A trigger inside the gap after the last fetch is deferred to the end of the
 * gap; one during a fetch is re-examined when the fetch lands. A failed fetch
 * is retried a few times with a growing delay (images that already failed do
 * not fire `error` again).
 *
 * Without a signed URL (before the fetch lands, a failed fetch, no GitHub
 * account) the original URL is kept.
 */
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type InjectionKey, type Ref } from "vue";
import { ghPrAttachmentUrls } from "../utils/backend";
import {
  attachmentKey,
  attachmentKeysIn,
  indexSignedAttachments,
  isSignedAttachmentUrl,
  type SignedAttachment,
} from "../utils/githubAttachments";

/** Image resolver for the inline threads; undefined when the PR is not on GitHub. */
export type ResolveImage = (src: string) => string | null;
/** Provided by the PR detail view for the inline comment threads it renders. */
export const PR_ATTACHMENTS_KEY: InjectionKey<Ref<ResolveImage | undefined>> = Symbol("prAttachments");

/** Minimum gap after a fetch, or a failed one, before the next fetch. */
const FETCH_GAP_MS = 30_000;
/** A signed URL this close to its expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 15_000;
/** Retries of a failing fetch (30 s, 1 min, 2 min, 4 min), then it waits for the next trigger. */
const MAX_RETRIES = 4;

/**
 * Checkouts (cwd) where a PR was found private this session: their next PRs
 * fetch up front. Only a hint — a PR may live in another repository than
 * `origin` (a fork's parent), and its own fetch says what it is.
 */
const privateCheckouts = new Set<string>();

/** For tests: forget what was learned about repositories. */
export function _resetRepoVisibility(): void {
  privateCheckouts.clear();
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
  /** The PR's repository is private (or likely so): signed URLs replace the originals. */
  const isPrivate = shallowRef(false);
  let prKey = "";
  let disposed = false;
  /** This PR's own fetch found its repository public: nothing to sign. */
  let foundPublic = false;
  let inFlight = false;
  /** Keys whose image failed while a fetch ran, re-examined when it lands. */
  let pendingKeys = new Set<string>();
  let lastFailure = -Infinity;
  let lastFetch = -Infinity;
  /**
   * Keys the bodies referenced when a fetch succeeded. One GitHub did not
   * return (past the first page of comments, a deleted file) is not fetched
   * again.
   */
  let asked = new Set<string>();
  /** The one scheduled fetch: a retry, or a trigger deferred past the gap. */
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Fetch in `delay` ms for the PR shown now, unless a fetch is already scheduled. */
  function schedule(delay: number): void {
    if (timer !== null) return;
    const key = prKey;
    timer = setTimeout(() => {
      timer = null;
      if (!disposed && key === prKey) load(true);
    }, delay);
  }

  /** Attachment keys the bodies reference, as a stable string for the watcher. */
  const wanted = computed(() => {
    if (!opts.enabled.value) return "";
    const keys = new Set<string>();
    for (const b of opts.bodies.value) for (const k of attachmentKeysIn(b)) keys.add(k);
    return [...keys].sort().join(",");
  });
  const wantedKeys = () => (wanted.value ? wanted.value.split(",") : []);

  /** Whether a fetch could give `k` a working URL it does not have. */
  function fetchWouldHelp(k: string): boolean {
    const entry = signed.value.get(k);
    return entry ? entry.expiresAt - EXPIRY_MARGIN_MS <= now() : !asked.has(k);
  }

  /** `scheduled`: the gap was already waited out (timer, or `trigger`'s check). */
  function load(scheduled = false): void {
    const cwd = opts.cwd.value;
    const n = opts.number.value;
    const keys = wantedKeys();
    if (disposed || inFlight || !cwd || n == null || !keys.length) return;
    if (!scheduled && now() - lastFailure < FETCH_GAP_MS) return;
    inFlight = true;
    lastFetch = now();
    const key = `${cwd}#${n}`;
    const sentAt = lastFetch;
    ghPrAttachmentUrls(cwd, n)
      .then((res) => {
        if (disposed || key !== prKey) return;
        retries = 0;
        clearTimer(); // a deferred trigger this fetch answers
        if (res.private === true) privateCheckouts.add(cwd);
        foundPublic = res.private === false;
        // Unknown (the repository could not be read): this fetch was asked
        // for because something failed, so use the URLs.
        isPrivate.value = res.private !== false;
        // Merged, not replaced: an attachment whose endpoint failed this time
        // keeps the URL it had.
        const next = new Map(signed.value);
        for (const [k, v] of indexSignedAttachments(res.urls, sentAt)) next.set(k, v);
        signed.value = next;
        for (const k of keys) asked.add(k);
      })
      .catch(() => {
        if (disposed || key !== prKey) return;
        lastFailure = now();
        if (retries >= MAX_RETRIES) return;
        const delay = FETCH_GAP_MS * 2 ** retries;
        retries++;
        clearTimer();
        schedule(delay);
      })
      .finally(() => {
        inFlight = false;
        if (disposed) return;
        // Images that failed meanwhile: fetch again only if this one did not fix them.
        const still = [...pendingKeys].some(fetchWouldHelp);
        pendingKeys = new Set();
        if (still) trigger();
        else check(); // bodies or the PR may have changed while this ran
      });
  }

  /** Up front, in a checkout found private: fetch for attachments not asked for yet. */
  function check(): void {
    if (!isPrivate.value || foundPublic) return;
    if (wantedKeys().some((k) => !signed.value.has(k) && !asked.has(k))) load();
  }

  /** Fetch now, or at the end of the gap — deferred, not dropped. */
  function trigger(): void {
    retries = 0; // a new trigger starts a new series of retries
    const wait = Math.max(lastFetch, lastFailure) + FETCH_GAP_MS - now();
    if (wait > 0) schedule(wait);
    else load(true);
  }

  watch(
    [() => opts.cwd.value, () => opts.number.value, wanted],
    ([cwd, n]) => {
      const key = `${cwd}#${n}`;
      if (key !== prKey) {
        prKey = key;
        signed.value = new Map();
        isPrivate.value = privateCheckouts.has(cwd);
        foundPublic = false;
        asked = new Set();
        pendingKeys = new Set();
        lastFailure = -Infinity;
        lastFetch = -Infinity;
        retries = 0;
        clearTimer();
      }
      check();
    },
    { immediate: true },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      clearTimer();
    });
  }

  /**
   * `error` listener, in the capture phase (the event does not bubble), on
   * the element holding the PR's rendered bodies.
   */
  function onImageError(e: Event): void {
    if (!opts.enabled.value) return;
    const el = e.target as Element | null;
    if (el?.tagName !== "IMG") return;
    const src = el.getAttribute("src");
    const k = src ? attachmentKey(src) : null;
    // Only the PR's stored bodies are in its body_html: an attachment pasted
    // in the editor, say, cannot be signed by fetching.
    if (!src || !k || !wantedKeys().includes(k)) return;
    // A public repository serves its attachments: a failure there (a deleted
    // file, the network) is not one signed URLs would fix.
    if (foundPublic) return;
    const entry = signed.value.get(k);
    const fixable = isSignedAttachmentUrl(src)
      ? // A signed URL: only an expired or superseded one.
        !entry || entry.url !== src || entry.expiresAt - EXPIRY_MARGIN_MS <= now()
      : // An original: unless its signed URL is in use already (a stale
        // render) or GitHub did not sign this file.
        !entry && !asked.has(k);
    if (!fixable) return;
    if (inFlight) pendingKeys.add(k);
    else trigger();
  }

  /** `resolveImage` for `renderMarkdown`: the signed URL of `src`, if any. */
  function resolveImage(src: string): string | null {
    // Pure check first: only bodies with attachments depend on the map.
    const k = attachmentKey(src);
    if (!k) return null;
    // Reactive reads: renders re-run when new URLs arrive.
    const map = signed.value;
    if (!isPrivate.value) return null;
    return map.get(k)?.url ?? null;
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

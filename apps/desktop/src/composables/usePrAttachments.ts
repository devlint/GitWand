/**
 * Signed URLs for the GitHub attachments of the PR being read (#302).
 *
 * A private repository answers 404 to the webview for the
 * `github.com/user-attachments/assets/<uuid>` URLs its markdown contains; the
 * API hands out signed equivalents that work for about five minutes
 * (`ghPrAttachmentUrls`). This loads them when the PR's bodies reference an
 * attachment, and gives the renderer a `resolveImage` that swaps them in.
 *
 * Without a signed URL (before the fetch lands, a failed fetch, no GitHub
 * account) the original URL is kept: on a public repository it works as is.
 *
 * Rendered bodies are cached in computeds, which re-run on data changes, not
 * with time: HTML holding an expired URL would be reused the next time a
 * section is re-created. So the URLs are fetched again shortly before they
 * expire — one timer, while the PR is open and has attachments, held while
 * the window is hidden — and the new map re-renders everything that used
 * them. Until then the previous URL stays in use: a re-render never falls
 * back to a URL a private repository does not serve.
 */
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type InjectionKey, type Ref } from "vue";
import { ghPrAttachmentUrls } from "../utils/backend";
import {
  attachmentKey,
  attachmentKeysIn,
  indexSignedAttachments,
  type SignedAttachment,
} from "../utils/githubAttachments";

/** Provided by the PR detail view for the inline comment threads it renders. */
export const PR_ATTACHMENTS_KEY: InjectionKey<(src: string) => string | null> = Symbol("prAttachments");

/** Fetch fresh URLs this long before the current ones expire. */
const EXPIRY_MARGIN_MS = 30_000;
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
  let inFlight = false;
  let lastFailure = -Infinity;
  /**
   * Keys the bodies referenced when the last successful fetch was sent. One
   * of them GitHub did not return (a body past the first page of comments, a
   * file that is not an image) will not come back by asking again.
   */
  let asked = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The refresh timer fired while the window was hidden. */
  let refreshDue = false;

  /** Attachment keys the bodies reference, as a stable string for the watcher. */
  const wanted = computed(() => {
    if (!opts.enabled.value) return "";
    const keys = new Set<string>();
    for (const b of opts.bodies.value) for (const k of attachmentKeysIn(b)) keys.add(k);
    return [...keys].sort().join(",");
  });
  const wantedKeys = () => (wanted.value ? wanted.value.split(",") : []);

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    refreshDue = false;
  }

  function arm(delay: number): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (typeof document !== "undefined" && document.hidden) refreshDue = true;
      else load();
    }, Math.max(delay, 0));
  }

  /** Refresh before the first URL in use expires. */
  function schedule(): void {
    if (!signed.value.size) return clearTimer();
    let first = Infinity;
    for (const e of signed.value.values()) first = Math.min(first, e.expiresAt);
    arm(Math.max(first - EXPIRY_MARGIN_MS - now(), RETRY_GAP_MS));
  }

  function load(): void {
    const cwd = opts.cwd.value;
    const n = opts.number.value;
    const keys = wantedKeys();
    if (!cwd || n == null || !keys.length || inFlight || now() - lastFailure < RETRY_GAP_MS) return;
    inFlight = true;
    const key = `${cwd}#${n}`;
    const sentAt = now();
    ghPrAttachmentUrls(cwd, n)
      .then((urls) => {
        if (key !== prKey) return;
        signed.value = indexSignedAttachments(urls, sentAt);
        asked = new Set(keys);
        schedule();
      })
      .catch(() => {
        // Keep what is shown; try again later if there are URLs to keep fresh.
        if (key !== prKey) return;
        lastFailure = now();
        if (signed.value.size) arm(RETRY_GAP_MS);
      })
      .finally(() => {
        inFlight = false;
        // The PR changed while this fetch ran: its own fetch was skipped.
        if (key !== prKey) check();
      });
  }

  /** Fetch when a referenced attachment is new or its URL is about to expire. */
  function check(): void {
    const t = now();
    const stale = wantedKeys().some((k) => {
      const e = signed.value.get(k);
      return e ? e.expiresAt - EXPIRY_MARGIN_MS <= t : !asked.has(k);
    });
    if (stale) load();
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
        clearTimer();
      }
      check();
    },
    { immediate: true },
  );

  function onVisibility(): void {
    if (refreshDue && !document.hidden) {
      refreshDue = false;
      load();
    }
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearTimer();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    });
  }

  /** `resolveImage` for `renderMarkdown`: the signed URL of `src`, if any. */
  function resolveImage(src: string): string | null {
    const k = attachmentKey(src);
    if (!k) return null;
    // Reactive read: renders re-run when new URLs arrive.
    return signed.value.get(k)?.url ?? null;
  }

  return { resolveImage, signed };
}

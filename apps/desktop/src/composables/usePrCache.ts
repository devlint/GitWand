/**
 * usePrCache.ts
 *
 * Disk-persisted stale-while-revalidate (SWR) cache for the PR panel.
 * Keeps the last-seen PR list (per repo + filter) and per-PR detail bundle so
 * the panel can paint instantly on repo-switch / tab re-open / cold app start,
 * then revalidate in the background.
 *
 * Mirrors the localStorage pattern in useLaunchpadPins.ts: module-level state,
 * defensive load/save, quota-guarded writes. PR diffs are intentionally NOT
 * cached here — they are large and already lazy-loaded on the Diff tab.
 */
import type {
  PullRequest,
  PullRequestDetail,
  CICheck,
  PrReviewComment,
  PrReview,
  RemoteInfo,
} from "../utils/backend";

export const PR_CACHE_STORAGE_KEY = "gitwand-pr-cache";
const STORAGE_KEY = PR_CACHE_STORAGE_KEY;

/** Entries older than this are dropped on load so storage doesn't grow forever. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
/** LRU caps (by `ts`) to bound localStorage footprint. */
const MAX_LISTS = 20;
const MAX_DETAILS = 40;

export interface CachedList {
  prs: PullRequest[];
  hasMore: boolean;
  ts: number;
}

export interface DetailBundle {
  detail: PullRequestDetail;
  /** Optional (A3) — the hot path no longer fetches checks/issueComments up
   *  front; they're written back once their tab's lazy loader fires. Read
   *  with a `?? []` default so an older cached entry still parses. */
  checks?: CICheck[];
  comments: PrReviewComment[];
  issueComments?: PrReviewComment[];
  reviews: PrReview[];
}

export interface CachedDetail extends DetailBundle {
  ts: number;
}

export interface CachedRemote {
  remote: RemoteInfo | null;
  ts: number;
}

interface PrCacheFile {
  lists: Record<string, CachedList>;
  details: Record<string, CachedDetail>;
  remotes: Record<string, CachedRemote>;
}

function emptyFile(): PrCacheFile {
  return { lists: {}, details: {}, remotes: {} };
}

// Strictly-increasing write clock. Wall-clock `Date.now()` can return the same
// value for several writes in one tick, which would make LRU eviction
// (sort-by-ts) non-deterministic and evict the wrong entries. Bumping past the
// last value guarantees recency order while staying ~equal to real time.
let _lastTs = 0;
function monoNow(): number {
  _lastTs = Math.max(Date.now(), _lastTs + 1);
  return _lastTs;
}

/** Drop entries older than MAX_AGE_MS from a `{ ts }`-keyed record. */
function pruneByAge<T extends { ts: number }>(rec: Record<string, T>, now: number): void {
  for (const k of Object.keys(rec)) {
    if (now - rec[k].ts > MAX_AGE_MS) delete rec[k];
  }
}

/** Keep only the `max` most-recent entries (highest `ts`); evict the rest. */
function evictLru<T extends { ts: number }>(rec: Record<string, T>, max: number): void {
  const keys = Object.keys(rec);
  if (keys.length <= max) return;
  keys
    .sort((a, b) => rec[b].ts - rec[a].ts)
    .slice(max)
    .forEach((k) => delete rec[k]);
}

function loadFromStorage(): PrCacheFile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyFile();
    const parsed = JSON.parse(raw) as Partial<PrCacheFile>;
    const file: PrCacheFile = {
      lists: parsed.lists ?? {},
      details: parsed.details ?? {},
      remotes: parsed.remotes ?? {},
    };
    const now = Date.now();
    pruneByAge(file.lists, now);
    pruneByAge(file.details, now);
    pruneByAge(file.remotes, now);
    return file;
  } catch {
    return emptyFile();
  }
}

function saveToStorage(file: PrCacheFile): void {
  evictLru(file.lists, MAX_LISTS);
  evictLru(file.details, MAX_DETAILS);
  evictLru(file.remotes, MAX_LISTS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch (e) {
    // QuotaExceededError (or any write failure): aggressively evict the oldest
    // detail bundles (the heaviest entries) and retry once. If it still fails,
    // give up silently — the cache is a best-effort optimisation.
    evictLru(file.details, Math.floor(MAX_DETAILS / 4));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    } catch {
      /* ignore — cache write is best-effort */
    }
  }
}

// ── Module-level singleton state ──────────────────────────────────────────────
let _file: PrCacheFile = loadFromStorage();

/** Reset state from localStorage. Only exported for use in Vitest tests. */
export function _resetPrCacheForTesting(): void {
  _file = loadFromStorage();
}

// ── Key helpers ───────────────────────────────────────────────────────────────
export function listKey(cwd: string, filterState: string): string {
  return `${cwd}::${filterState}`;
}
export function detailKey(cwd: string, prNumber: number): string {
  return `${cwd}::#${prNumber}`;
}

// ── Composable ────────────────────────────────────────────────────────────────
export function usePrCache() {
  function getList(key: string): CachedList | null {
    return _file.lists[key] ?? null;
  }

  function setList(key: string, prs: PullRequest[], hasMore: boolean): void {
    _file.lists[key] = { prs, hasMore, ts: monoNow() };
    saveToStorage(_file);
  }

  /** Drop every cached list for a repo — used after create / merge mutate it. */
  function invalidateLists(cwd: string): void {
    const prefix = `${cwd}::`;
    for (const k of Object.keys(_file.lists)) {
      if (k.startsWith(prefix)) delete _file.lists[k];
    }
    saveToStorage(_file);
  }

  function getDetail(key: string): CachedDetail | null {
    return _file.details[key] ?? null;
  }

  function setDetail(key: string, bundle: DetailBundle): void {
    _file.details[key] = { ...bundle, ts: monoNow() };
    saveToStorage(_file);
  }

  function invalidateDetail(cwd: string, prNumber: number): void {
    delete _file.details[detailKey(cwd, prNumber)];
    saveToStorage(_file);
  }

  function getRemote(cwd: string): CachedRemote | null {
    return _file.remotes[cwd] ?? null;
  }

  function setRemote(cwd: string, remote: RemoteInfo | null): void {
    _file.remotes[cwd] = { remote, ts: monoNow() };
    saveToStorage(_file);
  }

  return {
    getList, setList, invalidateLists,
    getDetail, setDetail, invalidateDetail,
    getRemote, setRemote,
  };
}

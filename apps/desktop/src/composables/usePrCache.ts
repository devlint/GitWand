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
  PendingReviewComment,
} from "../utils/backend";
import type { ReviewFinding } from "./usePrPreReview";

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

/**
 * Client-side per-PR viewed-file state (B2, v3.6.0), keyed by `detailKey`.
 * `headSha` pins the state to a specific head commit — GitHub has no native
 * "viewed" API, so the client is the source of truth, and a re-push (new
 * `headSha`) invalidates the whole PR's viewed set at once (coarser than
 * per-file blob-SHA invalidation, which is a noted follow-up).
 */
export interface ViewedState {
  headSha: string;
  paths: string[];
  ts: number;
}

/** A pending (not-yet-submitted) review draft, keyed by `detailKey` (B3). */
export interface DraftState {
  comments: PendingReviewComment[];
  ts: number;
}

/** Local dismissal memory for AI pre-review findings, keyed by `cwd` (C2).
 *  `classes` are `normalizeFindingClass` values (see `usePrFindingFilter.ts`) —
 *  dismissing a finding suppresses future occurrences of the same class,
 *  below the confidence threshold or not. */
export interface DismissedState {
  classes: string[];
  ts: number;
}

/** AI pre-review findings for a PR at a specific head SHA (C3), keyed
 *  `${detailKey}@${headSha}` — a headSha change simply misses the cache
 *  (no explicit invalidation needed; the stale key is pruned by age/LRU
 *  like every other entry). */
export interface FindingsState {
  findings: ReviewFinding[];
  ts: number;
}

interface PrCacheFile {
  lists: Record<string, CachedList>;
  details: Record<string, CachedDetail>;
  remotes: Record<string, CachedRemote>;
  viewed: Record<string, ViewedState>;
  drafts: Record<string, DraftState>;
  dismissedFindings: Record<string, DismissedState>;
  findings: Record<string, FindingsState>;
}

function emptyFile(): PrCacheFile {
  return {
    lists: {}, details: {}, remotes: {}, viewed: {}, drafts: {},
    dismissedFindings: {}, findings: {},
  };
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
      viewed: parsed.viewed ?? {},
      drafts: parsed.drafts ?? {},
      dismissedFindings: parsed.dismissedFindings ?? {},
      findings: parsed.findings ?? {},
    };
    const now = Date.now();
    pruneByAge(file.lists, now);
    pruneByAge(file.details, now);
    pruneByAge(file.remotes, now);
    pruneByAge(file.viewed, now);
    pruneByAge(file.drafts, now);
    pruneByAge(file.dismissedFindings, now);
    pruneByAge(file.findings, now);
    return file;
  } catch {
    return emptyFile();
  }
}

function saveToStorage(file: PrCacheFile): void {
  evictLru(file.lists, MAX_LISTS);
  evictLru(file.details, MAX_DETAILS);
  evictLru(file.remotes, MAX_LISTS);
  evictLru(file.viewed, MAX_DETAILS);
  evictLru(file.drafts, MAX_DETAILS);
  evictLru(file.dismissedFindings, MAX_LISTS);
  evictLru(file.findings, MAX_DETAILS);
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

  // ── Viewed-file state (B2) ────────────────────────────────────────────────

  function getViewed(key: string): { headSha: string; paths: string[] } | null {
    const v = _file.viewed[key];
    return v ? { headSha: v.headSha, paths: v.paths } : null;
  }

  function setViewed(key: string, headSha: string, paths: string[]): void {
    _file.viewed[key] = { headSha, paths, ts: monoNow() };
    saveToStorage(_file);
  }

  /**
   * Toggle `path` in/out of the viewed set for `key`. If the stored state was
   * recorded against a different `headSha` (a re-push happened), the whole
   * set is cleared first — "re-push resets viewed" at PR granularity (the
   * simplest honest behavior; per-file blob-SHA invalidation is a follow-up).
   */
  function toggleViewed(key: string, headSha: string, path: string): void {
    const existing = _file.viewed[key];
    const paths = existing && existing.headSha === headSha ? [...existing.paths] : [];
    const idx = paths.indexOf(path);
    if (idx === -1) paths.push(path);
    else paths.splice(idx, 1);
    _file.viewed[key] = { headSha, paths, ts: monoNow() };
    saveToStorage(_file);
  }

  // ── Pending review draft (B3) ─────────────────────────────────────────────

  function getDraft(key: string): PendingReviewComment[] | null {
    return _file.drafts[key]?.comments ?? null;
  }

  function setDraft(key: string, comments: PendingReviewComment[]): void {
    _file.drafts[key] = { comments, ts: monoNow() };
    saveToStorage(_file);
  }

  function clearDraft(key: string): void {
    delete _file.drafts[key];
    saveToStorage(_file);
  }

  // ── AI finding dismissal memory (C2) ──────────────────────────────────────

  function getDismissed(cwd: string): Set<string> {
    return new Set(_file.dismissedFindings[cwd]?.classes ?? []);
  }

  function addDismissed(cwd: string, cls: string): void {
    const existing = _file.dismissedFindings[cwd]?.classes ?? [];
    if (existing.includes(cls)) {
      // Still bump `ts` so an active repo's dismissal memory doesn't age out
      // ahead of genuinely idle ones under LRU eviction.
      _file.dismissedFindings[cwd] = { classes: existing, ts: monoNow() };
    } else {
      _file.dismissedFindings[cwd] = { classes: [...existing, cls], ts: monoNow() };
    }
    saveToStorage(_file);
  }

  // ── AI pre-review findings cache, by headSha (C3) ─────────────────────────

  function getFindings(key: string): ReviewFinding[] | null {
    return _file.findings[key]?.findings ?? null;
  }

  function setFindings(key: string, findings: ReviewFinding[]): void {
    _file.findings[key] = { findings, ts: monoNow() };
    saveToStorage(_file);
  }

  return {
    getList, setList, invalidateLists,
    getDetail, setDetail, invalidateDetail,
    getRemote, setRemote,
    getDismissed, addDismissed,
    getFindings, setFindings,
    getViewed, setViewed, toggleViewed,
    getDraft, setDraft, clearDraft,
  };
}

/**
 * commitReviewState.ts
 *
 * Task 4 (v3.7.0) — tracks review→fix→review iterations and the share of the
 * CURRENT staged diff already covered by a past review pass ("coverage"),
 * per repo. Task 5 extends this same pure module with the `GitWand-Review`
 * trailer builder and the commit-gate decision helpers, since both are pure
 * functions of the same iter/coverage/decision data.
 *
 * Content-hash based (not line-number based): a fix that shifts line numbers
 * must not destroy coverage — only the *content* of an added line matters
 * for "has this been reviewed", so the same line surviving a reflow (or
 * moving within the same hunk) is still recognised as already-covered.
 *
 * Persistence pattern mirrors `usePrCache.ts` / `useAiTasks.ts`: a
 * module-level singleton store, defensive load, quota-guarded save. Pure
 * functions (`hashLineKey`, `addedLineKeys`, `computeCoverage`) take no
 * mocks; the store itself is a thin localStorage-backed cache on top.
 */
import type { GitDiff } from "../utils/backend";

export const COMMIT_REVIEW_STATE_STORAGE_KEY = "gitwand-commit-review-state";
const STORAGE_KEY = COMMIT_REVIEW_STATE_STORAGE_KEY;

/** At most this many snapshots kept per repo (oldest evicted first). */
export const MAX_SNAPSHOTS = 10;
/** At most this many line hashes kept per snapshot (truncated, not rejected). */
export const MAX_HASHES = 20_000;
/** Snapshots older than this are dropped on load. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReviewedSnapshot {
  iter: number;
  ts: number;
  lineHashes: string[];
}

export interface CommitReviewRepoState {
  iterations: number;
  snapshots: ReviewedSnapshot[];
  updatedAt: number;
  /**
   * HEAD commit hash the current `iterations`/`snapshots` are valid for.
   * Verifier item #3 (v3.7.0 PR2 fixes) — without this, a commit made
   * OUTSIDE `proceedToCommit` (an amend, a terminal commit, any external
   * tool) leaves `iterations` pointing at a review cycle for a commit that
   * no longer exists; the next in-app commit would then silently write
   * `GitWand-Review: ran (iter:N, ...)` with no review having actually
   * happened against what's about to be committed. `""` means "not yet
   * known" (a fresh repo, or state persisted before this field existed) —
   * an empty stored value never by itself triggers a reset, only an actual
   * MISMATCH between two known hashes does (see `recordReview`/`reconcileHead`).
   */
  headHash: string;
}

interface CommitReviewStateFile {
  repos: Record<string, CommitReviewRepoState>;
}

function emptyFile(): CommitReviewStateFile {
  return { repos: {} };
}

function emptyRepoState(): CommitReviewRepoState {
  return { iterations: 0, snapshots: [], updatedAt: 0, headHash: "" };
}

// Strictly-increasing write clock — same rationale as `usePrCache.ts`'s
// `monoNow`: `Date.now()` can repeat within one tick, which would make
// snapshot LRU eviction (sort-by-ts) non-deterministic.
let _lastTs = 0;
function monoNow(): number {
  _lastTs = Math.max(Date.now(), _lastTs + 1);
  return _lastTs;
}

/** Normalise a cwd used as a store key — backslashes to "/", no trailing slash.
 *  Mirrors `useSettings.ts`'s `normaliseCwd` without importing Vue-settings
 *  machinery into this pure module. */
function normaliseCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Simple string hash (djb2) — stable across runs for the same input.
 *  Not cryptographic; collisions are an acceptable risk for this UI-only
 *  coverage signal. Mirrors `usePrPreReview.ts`'s `hashId`. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Stable identity for one added line, scoped by file path so identical
 *  content in two different files never collides. */
export function hashLineKey(path: string, content: string): string {
  return djb2(`${path}\0${content}`);
}

/** Every `type === "add"` line's hash, across all of `files` — content-based,
 *  not line-number-based, so a fix that only shifts line numbers doesn't
 *  drop coverage for content that hasn't actually changed. */
export function addedLineKeys(files: GitDiff[]): string[] {
  const keys: string[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") keys.push(hashLineKey(file.path, line.content));
      }
    }
  }
  return keys;
}

/** Share (0-100, rounded) of `current` that's present in `reviewed`. An
 *  empty `current` (nothing added in the staged diff) is vacuously 100% —
 *  there's nothing outstanding to review. */
export function computeCoverage(current: string[], reviewed: Set<string>): number {
  if (current.length === 0) return 100;
  let hit = 0;
  for (const k of current) if (reviewed.has(k)) hit++;
  return Math.round((100 * hit) / current.length);
}

/**
 * Drops snapshots older than `MAX_AGE_MS`. Verifier item #3 — if pruning
 * empties the snapshot list entirely, every piece of evidence backing
 * `iterations` has aged out; the count itself is no longer meaningful and
 * must reset to 0 rather than silently surviving with no snapshots left to
 * justify it (otherwise a stale `{iterations: 3, snapshots: []}` would let
 * the next commit skip the decision modal and write a lying trailer).
 * Leaves `iterations` alone when pruning only removed SOME snapshots.
 */
function pruneStaleSnapshots(state: CommitReviewRepoState, now: number): CommitReviewRepoState {
  const snapshots = state.snapshots.filter((s) => s && now - s.ts <= MAX_AGE_MS);
  if (snapshots.length === 0 && state.snapshots.length > 0) {
    return { ...state, snapshots, iterations: 0 };
  }
  return { ...state, snapshots };
}

function loadFromStorage(): CommitReviewStateFile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyFile();
    const parsed = JSON.parse(raw) as Partial<CommitReviewStateFile>;
    const reposRaw = parsed.repos && typeof parsed.repos === "object" ? parsed.repos : {};
    const now = Date.now();
    const repos: Record<string, CommitReviewRepoState> = {};
    for (const [cwd, state] of Object.entries(reposRaw)) {
      if (!state || typeof state !== "object") continue;
      const iterations = typeof state.iterations === "number" ? state.iterations : 0;
      const snapshots = Array.isArray(state.snapshots) ? state.snapshots : [];
      const updatedAt = typeof state.updatedAt === "number" ? state.updatedAt : now;
      const headHash = typeof state.headHash === "string" ? state.headHash : "";
      repos[cwd] = pruneStaleSnapshots({ iterations, snapshots, updatedAt, headHash }, now);
    }
    return { repos };
  } catch {
    return emptyFile();
  }
}

function saveToStorage(file: CommitReviewStateFile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // QuotaExceededError or similar — aggressively trim (keep only the most
    // recent snapshot per repo) and retry once; give up silently otherwise,
    // matching `usePrCache.ts`'s best-effort discipline.
    for (const key of Object.keys(file.repos)) {
      const state = file.repos[key];
      if (state.snapshots.length > 1) {
        file.repos[key] = { ...state, snapshots: state.snapshots.slice(-1) };
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    } catch {
      /* ignore — best-effort persistence */
    }
  }
}

// ── Module-level singleton state ──────────────────────────────────────────
let _file: CommitReviewStateFile = loadFromStorage();

/** Reset state from localStorage. Only exported for use in Vitest tests. */
export function _resetCommitReviewStateForTesting(): void {
  _file = loadFromStorage();
}

/** Current persisted state for `cwd`, or a fresh empty state if never reviewed. */
export function getState(cwd: string): CommitReviewRepoState {
  return _file.repos[normaliseCwd(cwd)] ?? emptyRepoState();
}

/** Union of every snapshot's line hashes recorded for `cwd` so far. */
export function reviewedHashesFor(cwd: string): Set<string> {
  const state = getState(cwd);
  const set = new Set<string>();
  for (const snap of state.snapshots) for (const h of snap.lineHashes) set.add(h);
  return set;
}

/** Coverage of `files`' added lines against everything reviewed for `cwd` so far. */
export function coverageFor(cwd: string, files: GitDiff[]): number {
  return computeCoverage(addedLineKeys(files), reviewedHashesFor(cwd));
}

/**
 * Records a completed (non-aborted) review pass over `files`: bumps the
 * iteration counter and appends a new snapshot of the added-line hashes it
 * covered. Caps snapshot count (oldest evicted) and per-snapshot hash count
 * (truncated) so a huge staged tree can't blow the localStorage quota.
 *
 * `headHash` (verifier item #3, optional — defaults to "" for back-compat)
 * is the repo's current HEAD commit at review time. When it's provided and
 * differs from whatever was last recorded for this repo, a commit happened
 * since the last review — the cycle restarts (iterations back to 1, old
 * snapshots dropped) instead of counting this review against a diff that no
 * longer applies to the current HEAD. An empty/omitted `headHash` never
 * triggers a reset by itself — only an actual mismatch between two KNOWN
 * hashes does.
 */
export function recordReview(cwd: string, files: GitDiff[], headHash: string = ""): void {
  const key = normaliseCwd(cwd);
  const existing = getState(cwd);
  const startingFresh = !!headHash && !!existing.headHash && existing.headHash !== headHash;
  const base = startingFresh ? emptyRepoState() : existing;
  const iterations = base.iterations + 1;

  let lineHashes = addedLineKeys(files);
  if (lineHashes.length > MAX_HASHES) lineHashes = lineHashes.slice(0, MAX_HASHES);

  const snapshot: ReviewedSnapshot = { iter: iterations, ts: monoNow(), lineHashes };
  let snapshots = [...base.snapshots, snapshot];
  if (snapshots.length > MAX_SNAPSHOTS) snapshots = snapshots.slice(snapshots.length - MAX_SNAPSHOTS);

  _file.repos[key] = {
    iterations,
    snapshots,
    updatedAt: Date.now(),
    headHash: headHash || existing.headHash,
  };
  saveToStorage(_file);
}

/**
 * Reconciles the persisted state for `cwd` against the repo's CURRENT HEAD
 * commit hash, without recording a new review pass. Used right before the
 * commit-time decision gate checks `iterations` (verifier item #3): if a
 * HEAD hash was previously recorded and it differs from `currentHeadHash`,
 * a commit happened since the last recorded review (an amend, a terminal
 * commit, or anything outside `proceedToCommit`) — the cycle resets to 0
 * iterations / no snapshots so the gate re-prompts instead of trusting a
 * stale count. A no-op (just stamps the hash) when there's nothing to
 * reconcile against yet, or when `currentHeadHash` can't be resolved
 * (empty string — e.g. a brand-new repo with no commits).
 */
export function reconcileHead(cwd: string, currentHeadHash: string): CommitReviewRepoState {
  const key = normaliseCwd(cwd);
  const existing = getState(cwd);
  if (!currentHeadHash || existing.headHash === currentHeadHash) return existing;

  const next: CommitReviewRepoState = existing.headHash
    ? { ...emptyRepoState(), headHash: currentHeadHash, updatedAt: Date.now() }
    : { ...existing, headHash: currentHeadHash };
  _file.repos[key] = next;
  saveToStorage(_file);
  return next;
}

/** Drop all recorded state for `cwd` — a new commit starts a new review cycle. */
export function clear(cwd: string): void {
  const key = normaliseCwd(cwd);
  if (!(key in _file.repos)) return;
  delete _file.repos[key];
  saveToStorage(_file);
}

// ── Task 5 — GitWand-Review trailer + commit-time decision gate ───────────
//
// UX contract identical to the v3.5.0 secrets scanner: never a hard stop.
// The commit-review decision modal offers three explicit outcomes instead
// of the secrets scanner's plain confirm, and cancelling it cancels the
// commit (it does NOT silently record "skipped" — decision D8).

export type ReviewDecision = "ran" | "vouched" | "skipped";

/**
 * Builds the `GitWand-Review` commit trailer. Shape:
 * `GitWand-Review: ran (iter:2, coverage:87%)`. When `iter` is 0 (a
 * vouch/skip with no review ever run this cycle) the parenthetical is
 * omitted entirely (decision D9) → `GitWand-Review: skipped`. `coverage` is
 * clamped to 0-100 and `iter` is floored at 0 (a negative value also drops
 * the parenthetical, same as 0). One line, no trailing newline — trailer
 * BLOCK assembly (Signed-off-by, Reviewed-by, …) stays the caller's job.
 *
 * The key is exactly `GitWand-Review` up to the FIRST colon — `git
 * interpret-trailers` only splits on the first `:`, and the parenthetical's
 * own `iter:N`/`coverage:X%` colons come after it, so they're part of the
 * value, never mistaken for the key.
 */
export function buildReviewTrailer(decision: ReviewDecision, iter: number, coverage: number): string {
  const clampedIter = Math.max(0, Math.floor(iter));
  const clampedCoverage = Math.max(0, Math.min(100, Math.round(coverage)));
  if (clampedIter === 0) return `GitWand-Review: ${decision}`;
  return `GitWand-Review: ${decision} (iter:${clampedIter}, coverage:${clampedCoverage}%)`;
}

export type CommitReviewGateAction = "prompt" | "proceed";

/**
 * Pure decision for whether `handleCommitRequest` needs to show the
 * Review / Vouch / Skip decision modal before proceeding. Factored out so
 * the exact gating logic the host uses is independently unit-testable
 * without mounting the host component (App.vue has no test harness).
 *
 * - Feature off, or nothing staged → always "proceed" (nothing to decide).
 * - A decision was already recorded this cycle → "proceed" (don't re-ask).
 * - A live, undismissed risk-severity finding (`unresolvedRiskCount > 0`)
 *   always earns one explicit decision, even when a review already ran this
 *   cycle: otherwise the commit records "ran" for a risk the user may never
 *   have looked at. Still not a hard stop (Vouch and Skip both proceed), and
 *   dismissing the finding removes it from the count, so it stops
 *   re-prompting.
 * - A review already ran this cycle (`iterations > 0`) even without an
 *   explicit decision yet — e.g. "Review staged changes" was clicked before
 *   ever hitting commit — → "proceed" without re-prompting; the trailer
 *   defaults to "ran" via `effectiveReviewDecision`.
 * - Otherwise → "prompt".
 */
export function resolveCommitReviewGate(input: {
  enabled: boolean;
  staged: number;
  decision: ReviewDecision | null;
  iterations: number;
  unresolvedRiskCount: number;
}): CommitReviewGateAction {
  if (!input.enabled || input.staged <= 0) return "proceed";
  if (input.decision !== null) return "proceed";
  // A live, undismissed risk-severity finding always earns one explicit
  // decision, even when a review already ran this cycle: otherwise the
  // commit records "ran" for a risk the user may never have looked at.
  // Still not a hard stop (Vouch and Skip both proceed), and dismissing the
  // finding removes it from `findings`, so it stops re-prompting.
  if (input.unresolvedRiskCount > 0) return "prompt";
  if (input.iterations > 0) return "proceed";
  return "prompt";
}

/**
 * The decision to actually record on the commit trailer once
 * `resolveCommitReviewGate` says "proceed": the explicit decision if one was
 * made, otherwise "ran" when a review already happened this cycle (the
 * "don't re-prompt, but still tell the truth" case above), otherwise `null`
 * (the gate should have prompted — this is the "nothing to record" case,
 * e.g. the feature is off or nothing is staged).
 */
export function effectiveReviewDecision(decision: ReviewDecision | null, iterations: number): ReviewDecision | null {
  if (decision !== null) return decision;
  return iterations > 0 ? "ran" : null;
}

/**
 * Appends the `GitWand-Review` trailer line as the LAST line of the trailer
 * block, after whatever `RepoSidebar.buildTrailers()` already produced
 * (Signed-off-by, Reviewed-by, …). Extracted as its own pure function
 * because getting this ordering wrong — or double-joining a blank line when
 * one side is empty — is the single most likely bug in the commit-review
 * decision gate (App.vue has no test harness of its own, so this is the
 * actual unit-tested assembly logic `proceedToCommit` calls).
 */
export function appendReviewTrailer(existingTrailers: string, reviewTrailerLine: string): string {
  return [existingTrailers, reviewTrailerLine].filter((s) => s.trim().length > 0).join("\n");
}

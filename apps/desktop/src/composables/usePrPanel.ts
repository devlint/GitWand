/**
 * usePrPanel.ts
 *
 * Singleton composable holding all Pull Request panel state.
 * Instantiated once in App.vue, provided via provide/inject so both
 * PrListSidebar (inside RepoSidebar) and PrDetailView (in <main>)
 * share the same reactive state.
 */
import { ref, computed, watch, onUnmounted, type Ref } from "vue";
import {
  gitFileCount,
  gitRemoteInfo,
  type PullRequest,
  type PullRequestDetail,
  type CICheck,
  type CIAnnotation,
  type RemoteInfo,
  type GitDiff,
  type DiffHunk,
  type DiffLine,
  type PrReviewComment,
  type CreatePrCommentParams,
  type PendingReviewComment,
  type PrReview,
  type PrConflictPreview,
  type PrHotspot,
  type PrFileHistory,
  ghForkInfo,
  type ForkInfo,
} from "../utils/backend";
import { forgeFromRemoteInfo, githubProvider } from "./forge/useForge";
import { usePrCache, listKey, detailKey } from "./usePrCache";
import { getPersistedDiffMode, type DiffMode } from "../utils/diffMode";
import { requireOnline } from "../utils/networkGuard";
import { t } from "./useI18n";

export const PR_PANEL_KEY = Symbol("prPanel");

/** Human-facing forge names for "Open on …" / platform labels. */
const FORGE_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
};

/**
 * Whether a PR's `mergeable` state means the branch has conflicts and cannot
 * merge. Forges spell this differently (GitHub `CONFLICTING`, GitLab
 * `CONFLICTS`, others `DIRTY`), so normalise here and reuse everywhere a
 * conflict needs to be flagged as a hard blocker.
 */
export function isMergeConflict(mergeable: string | null | undefined): boolean {
  return ["CONFLICTING", "CONFLICTS", "DIRTY"].includes((mergeable || "").toUpperCase());
}

export function usePrPanel(cwd: Ref<string>) {

  // Disk-persisted SWR cache — paints the list/detail instantly on repo-switch
  // or cold app start, then revalidates in the background. See usePrCache.ts.
  const cache = usePrCache();

  // ─── Remote / list ─────────────────────────────────────
  const remote = ref<RemoteInfo | null>(null);

  /** Provider actif dérivé du remote détecté — github par défaut. */
  const forge = computed(() =>
    remote.value ? forgeFromRemoteInfo(remote.value) : githubProvider,
  );

  /** Human-facing name of the active forge — used for "Open on …" labels. */
  const forgeLabel = computed(() => FORGE_LABELS[forge.value.name] ?? "Web");

  const prs = ref<PullRequest[]>([]);
  const loading = ref(false);
  // SWR: true while a background revalidation runs over cached data already on
  // screen. Distinct from `loading` (cold load, full-page spinner).
  const refreshing = ref(false);
  const error = ref<string | null>(null);
  // Optional follow-up action surfaced alongside an error. `"open-settings"`
  // is set when the failure is actionable from Settings (e.g. gh CLI missing
  // but the user can add a GitHub account instead). Reset on every reload.
  const errorAction = ref<"open-settings" | null>(null);
  const success = ref<string | null>(null);
  const filterState = ref<"open" | "closed" | "all">("open");
  /** 'all' = no user filter | 'assigned' = assignees | 'reviews' = review_requested */
  const filterMode = ref<'all' | 'assigned' | 'reviews'>('all');
  const currentUser = ref<string | null>(null);
  const currentUserLoading = ref(false);
  const currentUserError = ref<string | null>(null);

  // Create PR form
  const showCreateForm = ref(false);
  const newPrTitle = ref("");
  const newPrBody = ref("");
  const newPrBase = ref("");
  const newPrDraft = ref(false);
  const newPrReviewers = ref<string[]>([]);
  const isCreating = ref(false);
  // Fork target — when origin is a fork, the user can open the PR against the
  // upstream parent. `newPrBaseRepo` is "owner/repo" or "" for the origin.
  const forkInfo = ref<ForkInfo | null>(null);
  const newPrBaseRepo = ref("");

  // Merge dialog
  const mergingPr = ref<PullRequest | null>(null);
  const mergeMethod = ref<"merge" | "squash" | "rebase">("merge");

  // ─── Detail ────────────────────────────────────────────
  const selectedPr = ref<PullRequest | null>(null);
  const prDetail = ref<PullRequestDetail | null>(null);
  const prChecks = ref<CICheck[]>([]);
  // ─── CI annotations (v2.18) ─────────────────────────────
  // Lazy-loaded once per PR, when the Diff or Checks tab is opened.
  const prAnnotations = ref<CIAnnotation[]>([]);
  const annotationsLoading = ref(false);
  const annotationsLoaded = ref(false);
  const prDiffFiles = ref<GitDiff[]>([]);
  const prComments = ref<PrReviewComment[]>([]);
  const prIssueComments = ref<PrReviewComment[]>([]);
  const prReviews = ref<PrReview[]>([]);
  const detailLoading = ref(false);
  // SWR equivalent of `refreshing` for the detail pane: cached detail is shown
  // while the 6-call revalidation runs in the background.
  const detailRefreshing = ref(false);
  const detailError = ref<string | null>(null);
  const detailTab = ref<"info" | "diff" | "checks" | "intelligence">("info");
  const selectedDiffFile = ref<string | null>(null);
  const diffMode = ref<DiffMode>(getPersistedDiffMode());

  // ─── Draft review ──────────────────────────────────────
  const draftReviewComments = ref<PendingReviewComment[]>([]);
  const showReviewModal = ref(false);
  const submittingReview = ref(false);

  // ─── Phase 9.4 Intelligence ────────────────────────────
  const conflictPreview = ref<PrConflictPreview | null>(null);
  const conflictLoading = ref(false);
  const conflictError = ref<string | null>(null);
  const hotspots = ref<PrHotspot[]>([]);
  const hotspotsLoading = ref(false);
  const totalRepoFiles = ref(0);
  const fileHistory = ref<Record<string, PrFileHistory>>({});
  const fileHistoryLoading = ref(false);

  // ─── Boot-perf gating (v2.8.5) ─────────────────────────
  // `panelMounted` flips to true the first time the user opens the PR
  // view (PrListSidebar mounts and calls `init()`). Until then, cwd
  // changes (repo switches, new tab opens, dashboard interactions)
  // must NOT trigger `gh pr list` — at 50 PRs with heavy fields this
  // was a ~30s gh roundtrip happening at every repo open even when
  // the user only wanted to see the dashboard.
  const panelMounted = ref(false);

  // ─── Lazy pagination (v2.8.5 — §E partial) ──────────────
  // First page = 10 PRs (cf. `gh_list_prs` Rust limit default). Each
  // `loadMorePrs()` bumps the offset by PAGE_SIZE and appends.
  // `hasMore` becomes false as soon as a fetched page comes back
  // shorter than PAGE_SIZE — gh has nothing more to give us in this
  // state.
  // TODO Phase 2 (v2.9): replace the naive `fetch offset+limit + slice`
  // strategy with a cursor-based GraphQL `pullRequests(first:N, after:CURSOR)`
  // query so we don't re-walk already-fetched pages on each scroll.
  const PAGE_SIZE = 10;
  const hasMore = ref(true);
  const loadingMore = ref(false);

  // ─── Computed ──────────────────────────────────────────
  const commentsForFile = computed<PrReviewComment[]>(() =>
    selectedDiffFile.value
      ? prComments.value.filter((c) => c.path === selectedDiffFile.value)
      : [],
  );

  const commentCount = computed(() => prComments.value.length);

  const mergeReadiness = computed<{ ready: boolean; reason: string } | null>(() => {
    // A merge conflict blocks the PR on its own, even with no checks/reviews.
    const hasConflict = isMergeConflict(prDetail.value?.mergeable);
    if (!prReviews.value.length && !prChecks.value.length && !hasConflict) return null;
    // A check blocks merge only when it is genuinely failing or still pending.
    // Anything else (success, skipped, neutral, or a completed check with an
    // unrecognised/empty conclusion) is treated as fine — so a passing CI run is
    // never mislabelled as "waiting".
    const FAILING = ["FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"];
    const PENDING = ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"];
    const isBlocking = (c: CICheck) => {
      const concl = (c.conclusion || "").toUpperCase();
      if (FAILING.includes(concl)) return true;
      // Expired build (needs a re-queue) — a pending-style warning, still blocks.
      if (concl === "EXPIRED") return true;
      // Still running — no conclusion yet and a pending-looking state.
      return !concl && PENDING.includes((c.state || "").toUpperCase());
    };
    // Failing / pending checks + branch policies — surfaced by name so
    // forge-specific requirements (e.g. Azure "At least 1 reviewer must approve")
    // read clearly in the banner instead of a generic "checks failing".
    const unmet = prChecks.value.filter(isBlocking);
    const checksOk = unmet.length === 0;
    // Only each reviewer's *latest* verdict counts — a later APPROVED supersedes
    // an earlier CHANGES_REQUESTED (and vice versa). Scanning every historical
    // review would keep flagging "changes requested" after the reviewer has
    // since approved. COMMENTED / PENDING don't change a reviewer's verdict, so
    // they're skipped; DISMISSED clears it (counts as neither).
    const latestVerdictByUser = new Map<string, string>();
    for (const r of [...prReviews.value].sort((a, b) =>
      (a.submitted_at || "").localeCompare(b.submitted_at || ""),
    )) {
      const s = (r.state || "").toUpperCase();
      const login = r.user?.login;
      // Ghost/deleted reviewer has no stable identity to collapse on — skip it
      // rather than treating each of its reviews as a distinct verdict.
      if (!login) continue;
      if (s === "APPROVED" || s === "CHANGES_REQUESTED" || s === "DISMISSED") {
        latestVerdictByUser.set(login, s);
      }
    }
    const verdicts = [...latestVerdictByUser.values()];
    const hasApproval = verdicts.includes("APPROVED");
    const hasChangesRequested = verdicts.includes("CHANGES_REQUESTED");
    if (checksOk && hasApproval && !hasChangesRequested && !hasConflict) {
      return { ready: true, reason: t("pr.ready.ready") };
    }
    const reasons: string[] = [];
    // Merge conflict first — it's the hardest blocker.
    if (hasConflict) reasons.push(t("pr.ready.reasonMergeConflict"));
    // Prefer the concrete policy/check names; fall back to the generic label.
    // De-duplicate identical names (Azure can report the same policy twice, e.g.
    // an inherited + branch-level "At least 1 reviewer must approve").
    const names = [...new Set(unmet.map((c) => c.name).filter(Boolean))];
    if (names.length) reasons.push(...names);
    else if (!checksOk) reasons.push(t("pr.ready.reasonChecksFailing"));
    if (hasChangesRequested) reasons.push(t("pr.ready.reasonChangesRequested"));
    // A missing approval on its own isn't worth a banner — checks are green and
    // nobody requested changes, so we're just waiting for the merge. Hide it
    // rather than nag with "waiting: no approval". (Named reviewer *policies*
    // from `unmet` are still surfaced above.)
    if (reasons.length === 0) return null;
    return { ready: false, reason: t("pr.ready.waitingPrefix", reasons.join(", ")) };
  });

  /**
   * Whether the merge button must be disabled — either the viewer lacks the
   * role to merge (forge reported `canMerge === false`) or the PR has blocking
   * errors (conflict / failing or pending checks / requested changes). An
   * unknown permission (`canMerge` null) never disables on its own.
   */
  const mergeBlocked = computed<boolean>(() => {
    if (prDetail.value?.canMerge === false) return true;
    const r = mergeReadiness.value;
    return !!r && !r.ready;
  });

  /** Human-readable reason for a disabled merge button (tooltip). */
  const mergeBlockedReason = computed<string>(() => {
    if (prDetail.value?.canMerge === false) return t("pr.detail.mergeNoPermission");
    const r = mergeReadiness.value;
    return r && !r.ready ? r.reason : "";
  });

  /**
   * v2.10 — Virtual 'Merge Conflict' check surfaced in the CI tab.
   * If the PR's mergeable state is CONFLICTING, we unshift a hard failure
   * into the checks list so the user sees exactly what's blocking.
   */
  const checksWithConflict = computed(() => {
    const list = [...prChecks.value];
    if (prDetail.value?.mergeable === "CONFLICTING") {
      list.unshift({
        name: "Merge Conflict",
        state: "completed",
        conclusion: "FAILURE",
        detailsUrl: "",
      } as CICheck);
    }
    return list;
  });

  const selectedDiff = computed<GitDiff | null>(() =>
    selectedDiffFile.value
      ? (prDiffFiles.value.find((f) => f.path === selectedDiffFile.value) ?? null)
      : null,
  );

  const displayedPrs = computed<PullRequest[]>(() => {
    if (filterMode.value === 'all') return prs.value;
    const me = currentUser.value;
    // Identity not yet resolved — return empty so the loading/error state is visible
    if (!me) return [];
    const meLower = me.toLowerCase();
    if (filterMode.value === 'assigned') {
      return prs.value.filter((pr) =>
        pr.assignees.some((a) => a.toLowerCase() === meLower),
      );
    }
    // reviews: requested reviewer
    return prs.value.filter((pr) =>
      pr.reviewRequested.some((r) => r.toLowerCase() === meLower),
    );
  });

  // ─── Parse unified diff ─────────────────────────────────
  function parseUnifiedDiff(rawDiff: string): GitDiff[] {
    const files: GitDiff[] = [];
    if (!rawDiff.trim()) return files;
    const lines = rawDiff.split("\n");
    let currentFile: GitDiff | null = null;
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0, newLine = 0;
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        if (currentFile) files.push(currentFile);
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        currentFile = { path: match ? match[2] : "unknown", hunks: [] };
        currentHunk = null;
        continue;
      }
      if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
          line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("new file ") ||
          line.startsWith("deleted file ") || line.startsWith("similarity index ") ||
          line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("Binary files ")) continue;
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (hunkMatch && currentFile) {
        currentHunk = {
          header: line,
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: parseInt(hunkMatch[2] ?? "1", 10),
          newStart: parseInt(hunkMatch[3], 10),
          newCount: parseInt(hunkMatch[4] ?? "1", 10),
          lines: [],
        };
        currentFile.hunks.push(currentHunk);
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[3], 10);
        continue;
      }
      if (currentHunk) {
        if (line.startsWith("+")) {
          currentHunk.lines.push({ type: "add", content: line.substring(1), newLineNo: newLine++ });
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({ type: "delete", content: line.substring(1), oldLineNo: oldLine++ });
        } else if (line.startsWith(" ") || line === "") {
          currentHunk.lines.push({ type: "context", content: line.startsWith(" ") ? line.substring(1) : line, oldLineNo: oldLine++, newLineNo: newLine++ });
        }
      }
    }
    if (currentFile) files.push(currentFile);
    return files;
  }

  // ─── Data loading ───────────────────────────────────────
  async function loadRemote() {
    // SWR: seed from cache so `forge` resolves on the first paint instead of
    // waiting on `gitRemoteInfo` before `init()` can call `loadPrs()`.
    const cached = cache.getRemote(cwd.value);
    if (cached) remote.value = cached.remote;
    try {
      const fresh = await gitRemoteInfo(cwd.value);
      remote.value = fresh;
      cache.setRemote(cwd.value, fresh);
    } catch {
      if (!cached) remote.value = null;
    }
  }

  /**
   * Detect the GitHub fork relationship so the create view can default the PR
   * target to the upstream parent. GitHub-only; silently no-ops elsewhere.
   * On a fork, pre-select upstream as the target (the common intent).
   */
  async function loadForkInfo() {
    forkInfo.value = null;
    newPrBaseRepo.value = "";
    if (forge.value.name !== "github") return;
    try {
      const info = await ghForkInfo(cwd.value);
      forkInfo.value = info;
      if (info.isFork && info.parent) newPrBaseRepo.value = info.parent;
    } catch {
      forkInfo.value = null;
    }
  }

  async function loadPrs() {
    if (!cwd.value) return;
    // SWR: paint cached PRs immediately, then revalidate in the background.
    // A cache hit means `loading` (cold full-page spinner) stays false and we
    // only flip the subtle `refreshing` flag instead.
    const key = listKey(cwd.value, filterState.value);
    const cached = cache.getList(key);
    if (cached) {
      prs.value = cached.prs;
      hasMore.value = cached.hasMore;
    }
    // F1 — Mode hors-ligne: short-circuit before the gh subprocess.
    // `gh pr list` itself would hang on DNS / TCP timeout for the user
    // visible duration of the IPC, leaving the panel stuck on a spinner.
    if (!(await requireOnline("gh pr list"))) {
      // Keep cached data on screen when offline; only wipe when we have none.
      if (!cached) {
        prs.value = [];
        hasMore.value = false;
      }
      loading.value = false;
      refreshing.value = false;
      error.value = t("connectivity.offline.disabledOp");
      return;
    }
    if (cached) refreshing.value = true; else loading.value = true;
    error.value = null;
    errorAction.value = null;
    // Reset pagination — first page only
    hasMore.value = true;
    try {
      const page = await forge.value.listPRs(cwd.value, { state: filterState.value, limit: PAGE_SIZE, offset: 0 });
      prs.value = page;
      // If gh returned fewer than asked, there's nothing more to fetch.
      hasMore.value = page.length >= PAGE_SIZE;
      cache.setList(key, page, hasMore.value);
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      // §B2 — surface the raw underlying error so users + maintainers can
      // see what `gh` actually returned (auth/scope/remote issue, etc.).
      console.error("[usePrPanel] gh pr list failed:", msg);
      const isGhMissing =
        // Rust os error when binary not found in PATH
        msg.includes("No such file or directory") ||
        msg.includes("program not found") ||
        msg.includes("ENOENT") ||
        // Our own error prefix
        (msg.includes("gh") && msg.includes("installed"));
      if (isGhMissing) {
        error.value = t("pr.error.ghNotInstalled");
        errorAction.value = "open-settings";
      } else if (msg.includes("gh auth") || msg.includes("authentication") || msg.includes("token") || msg.includes("401")) {
        error.value = t("pr.error.noToken");
      } else if (msg.includes("404") || msg.includes("Could not resolve to a Repository")) {
        error.value = t("pr.error.noRemote");
      } else {
        error.value = msg || t("pr.error.unknown");
      }
      // SWR: keep the stale list on screen when revalidation fails — yanking it
      // to an empty error state is more jarring than a soft error banner.
      if (!cached) {
        prs.value = [];
        hasMore.value = false;
      }
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  }

  /**
   * Append the next page of PRs to the existing list.
   * Idempotent guards:
   *   - `loadingMore` prevents double-fire from rapid IntersectionObserver
   *     callbacks (the same sentinel can enter/leave the viewport several
   *     times during inertial scroll).
   *   - `hasMore` short-circuits once we know `gh` has nothing more to give.
   *   - Result dedup-by-`number` defends against the (rare) case where the
   *     PR list shifts between requests — e.g. a new PR is opened mid-scroll
   *     and the naive `offset+limit` view double-counts the boundary item.
   *
   * Phase 2 (v2.9) will replace this with a cursor-based GraphQL query,
   * making the dedup + slice cost go away.
   */
  async function loadMorePrs() {
    // Guard on `refreshing` too: during SWR revalidation the cached list is on
    // screen with `loading` false, so without this the pagination sentinel
    // fires a second `listPRs` (e.g. offset 4) concurrently with the in-flight
    // page-0 refresh — doubling slow forge calls (Azure: ~1.8s each).
    if (!cwd.value || loadingMore.value || !hasMore.value || loading.value || refreshing.value) return;
    if (!(await requireOnline("gh pr list (more)"))) {
      hasMore.value = false;
      return;
    }
    loadingMore.value = true;
    try {
      const page = await forge.value.listPRs(cwd.value, { state: filterState.value, limit: PAGE_SIZE, offset: prs.value.length });
      if (page.length === 0) {
        hasMore.value = false;
      } else {
        // Dedup by PR number — the underlying `gh pr list` re-fetch can
        // shift the window if PRs are opened/closed concurrently.
        const seen = new Set(prs.value.map((p) => p.number));
        for (const pr of page) {
          if (!seen.has(pr.number)) prs.value.push(pr);
        }
        hasMore.value = page.length >= PAGE_SIZE;
      }
    } catch (e) {
      // Don't surface scroll-load errors as a banner — silent stop is
      // less intrusive than yanking a half-loaded list to an error state.
      console.warn("[usePrPanel] loadMorePrs failed:", e);
      hasMore.value = false;
    } finally {
      loadingMore.value = false;
    }
  }

  function resetDetail() {
    prDetail.value = null;
    prChecks.value = [];
    prAnnotations.value = [];
    annotationsLoaded.value = false;
    prDiffFiles.value = [];
    prComments.value = [];
    prIssueComments.value = [];
    prReviews.value = [];
    draftReviewComments.value = [];
    conflictPreview.value = null;
    conflictError.value = null;
    hotspots.value = [];
    fileHistory.value = {};
    selectedDiffFile.value = null;
    detailTab.value = "info";
  }

  async function selectPr(pr: PullRequest) {
    if (selectedPr.value?.number === pr.number) return;
    selectedPr.value = pr;
    resetDetail();
    // SWR: paint cached detail bundle instantly, revalidate in background.
    const cached = cache.getDetail(detailKey(cwd.value, pr.number));
    if (cached) {
      prDetail.value = cached.detail;
      prChecks.value = cached.checks;
      prComments.value = cached.comments;
      prIssueComments.value = cached.issueComments;
      prReviews.value = cached.reviews;
      detailRefreshing.value = true;
    } else {
      detailLoading.value = true;
    }
    await fetchDetailBundle(pr, { silentError: !!cached });
  }

  /**
   * Fetch (or revalidate) the full detail bundle for `pr` and write it back to
   * the cache. The caller sets `detailLoading` / `detailRefreshing` before
   * awaiting; both are cleared here. `silentError` keeps the stale bundle on
   * screen instead of surfacing an error (used for cache-hit + background
   * revalidation, where there is already content to show).
   */
  async function fetchDetailBundle(pr: PullRequest, { silentError }: { silentError: boolean }) {
    const key = detailKey(cwd.value, pr.number);
    detailError.value = null;
    try {
      const [detail, checks, comments, issueComments, reviews, fileCount] = await Promise.all([
        forge.value.getPR(cwd.value, pr.number),
        forge.value.getCIChecks(cwd.value, pr.number).catch(() => [] as CICheck[]),
        forge.value.listComments(cwd.value, pr.number).catch(() => [] as PrReviewComment[]),
        forge.value.listIssueComments?.(cwd.value, pr.number).catch(() => [] as PrReviewComment[]) ?? Promise.resolve([] as PrReviewComment[]),
        forge.value.listReviews(cwd.value, pr.number).catch(() => [] as PrReview[]),
        gitFileCount(cwd.value).catch(() => 0),
      ]);
      // Ignore a stale response if the user moved on to another PR meanwhile.
      if (selectedPr.value?.number !== pr.number) return;
      prDetail.value = detail;
      prChecks.value = checks;
      prComments.value = comments;
      prIssueComments.value = issueComments;
      prReviews.value = reviews;

      // Azure DevOps API doesn't include comment counts in the PR object.
      // We populate them from the actual comments list we just fetched.
      if (forge.value.name === "azure" && prDetail.value) {
        prDetail.value.reviewComments = comments.length;
        prDetail.value.comments = 0;
      }

      totalRepoFiles.value = fileCount;
      cache.setDetail(key, { detail, checks, comments, issueComments, reviews });
    } catch (err: any) {
      // Keep the cached bundle on screen if revalidation failed.
      if (!silentError) detailError.value = err.message;
    } finally {
      detailLoading.value = false;
      detailRefreshing.value = false;
    }
  }

  /** Re-fetch the currently open detail bundle in the background (poll-driven). */
  async function revalidateOpenDetail() {
    const pr = selectedPr.value;
    if (!pr) return;
    detailRefreshing.value = true;
    await fetchDetailBundle(pr, { silentError: true });
  }

  /** Write the current detail refs back to the SWR cache (write-through after
   *  a comment / review mutation so the cached bundle stays fresh). */
  function persistDetailCache() {
    if (!selectedPr.value || !prDetail.value) return;
    cache.setDetail(detailKey(cwd.value, selectedPr.value.number), {
      detail: prDetail.value,
      checks: prChecks.value,
      comments: prComments.value,
      issueComments: prIssueComments.value,
      reviews: prReviews.value,
    });
  }

  async function refreshComments() {
    if (!selectedPr.value) return;
    try {
      prComments.value = await forge.value.listComments(cwd.value, selectedPr.value.number);
      persistDetailCache();
    } catch { /* silent */ }
  }

  async function loadDiff() {
    if (!selectedPr.value || prDiffFiles.value.length) return;
    detailLoading.value = true;
    try {
      const raw = await forge.value.getPRDiff(cwd.value, selectedPr.value.number);
      prDiffFiles.value = parseUnifiedDiff(raw);
      if (prDiffFiles.value.length) selectedDiffFile.value = prDiffFiles.value[0].path;
    } catch (err: any) {
      detailError.value = err.message;
    } finally {
      detailLoading.value = false;
    }
  }

  /**
   * Load check-run annotations (v2.18). Lazy: fired the first time the
   * Diff or Checks tab is opened for the selected PR. One flight max —
   * `annotationsLoaded` stays true even on an empty result, so a CI
   * without annotations doesn't re-trigger the forge call on every
   * tab switch.
   */
  async function loadAnnotations() {
    if (!selectedPr.value || annotationsLoaded.value || annotationsLoading.value) return;
    annotationsLoading.value = true;
    try {
      prAnnotations.value = await forge.value.getCheckAnnotations(
        cwd.value,
        selectedPr.value.number,
      );
      annotationsLoaded.value = true;
    } catch {
      // Non-fatal — gutter and badges simply stay empty.
      annotationsLoaded.value = true;
    } finally {
      annotationsLoading.value = false;
    }
  }

  /** Annotation count per check name — feeds the "N annotations" badge (CI tab). */
  const annotationCountByCheck = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const a of prAnnotations.value) {
      counts[a.checkName] = (counts[a.checkName] ?? 0) + 1;
    }
    return counts;
  });

  /** Annotations grouped by file path — feeds the diff gutter icons. */
  const annotationsByFile = computed<Record<string, CIAnnotation[]>>(() => {
    const map: Record<string, CIAnnotation[]> = {};
    for (const a of prAnnotations.value) {
      (map[a.path] ??= []).push(a);
    }
    return map;
  });

  watch(detailTab, async (tab) => {
    if (tab === "diff") {
      loadDiff();
      loadAnnotations();
    }
    if (tab === "checks") loadAnnotations();
    if (tab === "intelligence") {
      if (prDiffFiles.value.length === 0) await loadDiff();
      if (!hotspots.value.length) loadHotspots();
      if (!Object.keys(fileHistory.value).length) loadFileHistory();
    }
  });

  // Reset + reload when repo changes.
  // v2.8.5 boot-perf: previously `init()` was called unconditionally on
  // every cwd change, which would trigger `gh pr list` (50 PRs × heavy
  // fields × per-PR roundtrips) even when the user never opened the PR
  // view. Now we only reload when the panel has actually been mounted
  // at least once during this session. The flag flips inside `init()`
  // (called from PrListSidebar.onMounted) so the first user-driven
  // open is the trigger.
  watch(cwd, (newCwd) => {
    selectedPr.value = null;
    prs.value = [];
    remote.value = null;
    resetDetail();
    if (newCwd && panelMounted.value) init();
  });

  // ─── PR actions ─────────────────────────────────────────
  async function createPr() {
    if (!cwd.value || !newPrTitle.value.trim()) return;
    if (!(await requireOnline("gh pr create"))) {
      error.value = t("connectivity.offline.disabledOp");
      return;
    }
    isCreating.value = true;
    error.value = null;
    try {
      // Only treat baseRepo as cross-fork when it differs from origin.
      const target = newPrBaseRepo.value.trim();
      const baseRepo = target && target !== forkInfo.value?.origin ? target : "";
      const pr = await forge.value.createPR(cwd.value, {
        title: newPrTitle.value.trim(),
        body: newPrBody.value.trim(),
        base: newPrBase.value.trim(),
        baseRepo,
        draft: newPrDraft.value,
        reviewers: newPrReviewers.value.slice(),
      });
      success.value = t("pr.success.prCreated", pr.number);
      showCreateForm.value = false;
      newPrTitle.value = ""; newPrBody.value = ""; newPrDraft.value = false;
      newPrReviewers.value = [];
      cache.invalidateLists(cwd.value);
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
    finally { isCreating.value = false; }
  }

  async function checkoutPr(pr: PullRequest) {
    if (!(await requireOnline("gh pr checkout"))) {
      error.value = t("connectivity.offline.disabledOp");
      return;
    }
    try {
      await forge.value.checkoutPR(cwd.value, pr.number);
      success.value = t("pr.success.checkoutDone", pr.number);
    } catch (err: any) { error.value = err.message; }
  }

  /**
   * Convert a draft PR to ready-for-review.
   * Silently ignored for forges that don't support it (ForgeNotImplementedError).
   * On success, refreshes the PR detail so the draft badge disappears.
   */
  async function convertDraftToReady(pr: PullRequest) {
    if (!(await requireOnline("pr ready"))) {
      error.value = t("connectivity.offline.disabledOp");
      return;
    }
    try {
      await forge.value.convertDraftToReady(cwd.value, pr.number);
      // Optimistic update — flip the draft flag locally so the button hides immediately.
      if (selectedPr.value?.number === pr.number) {
        selectedPr.value = { ...selectedPr.value, draft: false };
      }
      if (prDetail.value?.number === pr.number) {
        prDetail.value = { ...prDetail.value, draft: false };
      }
      success.value = t("pr.success.markedAsReady", pr.number);
    } catch (err: any) {
      // ForgeNotImplementedError (e.g. Bitbucket) — don't surface as an error.
      if (err.message?.includes("ForgeNotImplementedError") || err.message?.includes("deferred")) return;
      error.value = err.message;
    }
  }

  async function mergePr() {
    if (!mergingPr.value) return;
    if (!(await requireOnline("gh pr merge"))) {
      error.value = t("connectivity.offline.disabledOp");
      return;
    }
    try {
      await forge.value.mergePR(cwd.value, mergingPr.value.number, mergeMethod.value);
      success.value = t("pr.success.prMerged", mergingPr.value.number);
      cache.invalidateDetail(cwd.value, mergingPr.value.number);
      cache.invalidateLists(cwd.value);
      mergingPr.value = null;
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
  }

  // ─── Comment actions ────────────────────────────────────
  async function handleCreateComment(params: CreatePrCommentParams & { path: string }) {
    if (!selectedPr.value) return;
    try {
      await forge.value.createComment(cwd.value, selectedPr.value.number, params);
      await refreshComments();
      if (prDetail.value) prDetail.value.reviewComments++;
      persistDetailCache();
    } catch (err: any) { error.value = err.message; }
  }

  async function handleReplyComment(inReplyToId: number, body: string) {
    if (!selectedPr.value) return;
    try {
      await forge.value.createComment(cwd.value, selectedPr.value.number, { body, in_reply_to_id: inReplyToId });
      await refreshComments();
    } catch (err: any) { error.value = err.message; }
  }

  async function handleEditComment(id: number, body: string) {
    try {
      await forge.value.updateComment(cwd.value, id, body);
      const idx = prComments.value.findIndex((c) => c.id === id);
      if (idx !== -1) prComments.value[idx] = { ...prComments.value[idx], body, updated_at: new Date().toISOString() };
      persistDetailCache();
    } catch (err: any) { error.value = err.message; }
  }

  async function handleDeleteComment(id: number) {
    try {
      await forge.value.deleteComment(cwd.value, id);
      prComments.value = prComments.value.filter((c) => c.id !== id && c.in_reply_to_id !== id);
      if (prDetail.value && prDetail.value.reviewComments > 0) prDetail.value.reviewComments--;
      persistDetailCache();
    } catch (err: any) { error.value = err.message; }
  }

  function handleApplySuggestion(suggestion: string, startLine: number | null, endLine: number | null) {
    navigator.clipboard?.writeText(suggestion).catch(() => {});
    success.value = t("pr.success.suggestionCopied", startLine ?? "?", endLine ?? "?");
  }

  function handleAddToReview(params: {
    path: string; line: number; side: "LEFT" | "RIGHT";
    start_line?: number; start_side?: "LEFT" | "RIGHT"; body: string;
  }) {
    draftReviewComments.value.push({
      path: params.path, line: params.line, side: params.side,
      ...(params.start_line !== undefined ? { start_line: params.start_line } : {}),
      ...(params.start_side !== undefined ? { start_side: params.start_side } : {}),
      body: params.body,
    });
    success.value = t("pr.success.commentAddedToReview", draftReviewComments.value.length);
  }

  async function handleSubmitReview(opts: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    comments: PendingReviewComment[];
  }) {
    if (!selectedPr.value) return;
    submittingReview.value = true;
    try {
      await forge.value.submitReview(cwd.value, selectedPr.value.number, opts);
      showReviewModal.value = false;
      draftReviewComments.value = [];
      const [reviews, comments] = await Promise.all([
        forge.value.listReviews(cwd.value, selectedPr.value.number).catch(() => [] as PrReview[]),
        forge.value.listComments(cwd.value, selectedPr.value.number).catch(() => [] as PrReviewComment[]),
      ]);
      prReviews.value = reviews;
      prComments.value = comments;
      persistDetailCache();
      success.value = t("pr.success.reviewSubmitted", opts.event);
    } catch (err: any) {
      error.value = err.message;
    } finally {
      submittingReview.value = false;
    }
  }

  // ─── Intelligence handlers ──────────────────────────────
  async function loadConflictPreview() {
    if (!selectedPr.value || conflictLoading.value) return;
    conflictLoading.value = true;
    conflictError.value = null;
    try {
      conflictPreview.value = await forge.value.getConflictPreview(cwd.value, selectedPr.value.number);
    } catch (err: any) {
      conflictError.value = err.message;
    } finally {
      conflictLoading.value = false;
    }
  }

  async function loadHotspots() {
    if (!prDiffFiles.value.length || hotspotsLoading.value) return;
    hotspotsLoading.value = true;
    try {
      hotspots.value = await forge.value.getHotspots(cwd.value, prDiffFiles.value.map((f) => f.path));
    } catch { /* silent */ } finally { hotspotsLoading.value = false; }
  }

  async function loadFileHistory() {
    if (!prDiffFiles.value.length || fileHistoryLoading.value) return;
    fileHistoryLoading.value = true;
    try {
      fileHistory.value = await forge.value.getFileHistory(cwd.value, prDiffFiles.value.map((f) => f.path));
    } catch { /* silent */ } finally { fileHistoryLoading.value = false; }
  }

  // ─── Helpers ────────────────────────────────────────────
  function timeAgo(dateStr: string): string {
    try {
      const d = new Date(dateStr), now = new Date();
      const diff = now.getTime() - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}j`;
    } catch { return dateStr; }
  }

  function checkIcon(c: CICheck): string {
    const s = (c.conclusion || c.state || "").toUpperCase();
    if (s === "SUCCESS") return "✅";
    if (["FAILURE", "ERROR", "CANCELLED"].includes(s)) return "❌";
    if (s === "EXPIRED") return "⚠️";
    if (["PENDING", "IN_PROGRESS", "QUEUED"].includes(s)) return "⏳";
    if (s === "SKIPPED") return "⏭️";
    return "❓";
  }

  function checksIcon(status: string): string {
    const s = status.toUpperCase();
    if (s === "SUCCESS" || s === "PASS") return "✅";
    if (["FAILURE", "FAIL", "ERROR"].includes(s)) return "❌";
    if (s === "PENDING") return "⏳";
    return "";
  }

  function mergeableIcon(s: string) {
    switch (s.toUpperCase()) {
      case "MERGEABLE": return "✅";
      case "CONFLICTING": return "⚠️";
      default: return "—";
    }
  }

  function renderBody(body: string): string {
    return body
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, '<code class="pr-code">$1</code>')
      .replace(/\n/g, "<br />");
  }

  // ─── Init ───────────────────────────────────────────────
  async function loadCurrentUser() {
    if (currentUserLoading.value) return;
    currentUserLoading.value = true;
    currentUserError.value = null;
    try {
      const login = await forge.value.getCurrentUser(cwd.value);
      currentUser.value = login;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      currentUserError.value = msg;
      console.error('[usePrPanel] ghCurrentUser failed:', msg);
    } finally {
      currentUserLoading.value = false;
    }
  }

  // ─── Visibility-gated background revalidation (5 min) ──────────
  // SWR is otherwise event-driven only (open list / select PR / actions). This
  // refreshes the active view on a slow cadence so a long-open panel doesn't go
  // stale. Perf discipline (apps/desktop/CLAUDE.md): the interval is cleared on
  // `document.hidden` and restarted on return — never runs in the background.
  const REVALIDATE_INTERVAL_MS = 5 * 60 * 1000;
  let _pollTimer: ReturnType<typeof setInterval> | null = null;
  let _lastPoll = 0;
  let _visibilityHandler: (() => void) | null = null;

  function pollTick() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!cwd.value) return;
    _lastPoll = Date.now();
    // Revalidate whichever view is active — the open detail, else the list.
    if (selectedPr.value) void revalidateOpenDetail();
    else void loadPrs();
  }

  function startPoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(pollTick, REVALIDATE_INTERVAL_MS);
  }

  function stopPoll() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopPoll();
    } else {
      startPoll();
      // Catch up immediately if a full interval elapsed while hidden, but don't
      // refetch on every brief alt-tab.
      if (Date.now() - _lastPoll >= REVALIDATE_INTERVAL_MS) pollTick();
    }
  }

  if (typeof document !== "undefined") {
    _visibilityHandler = handleVisibilityChange;
    document.addEventListener("visibilitychange", _visibilityHandler);
  }

  onUnmounted(() => {
    stopPoll();
    if (typeof document !== "undefined" && _visibilityHandler) {
      document.removeEventListener("visibilitychange", _visibilityHandler);
    }
  });

  async function init() {
    // Flip the mounted flag — see `panelMounted` declaration for rationale.
    // From now on, cwd changes will auto-reload the PR list because the
    // user has expressed intent by opening the PR view at least once.
    panelMounted.value = true;
    // SWR: with a cached remote we resolve `forge` synchronously and revalidate
    // in the background, so `loadPrs()` paints from its own cache without first
    // waiting on the `gitRemoteInfo` roundtrip. Cold (no cache) still awaits so
    // the correct forge is known before listing a non-GitHub repo.
    const cachedRemote = cache.getRemote(cwd.value);
    if (cachedRemote) {
      remote.value = cachedRemote.remote;
      loadRemote();
    } else {
      await loadRemote();
    }
    await loadPrs();
    // Load current user in background for "assigned / reviews" filter
    loadCurrentUser();
    // Fork detection in background — only affects the create view.
    loadForkInfo();
    // Start the 5-min visibility-gated revalidation loop (no-op if hidden).
    _lastPoll = Date.now();
    if (typeof document === "undefined" || !document.hidden) startPoll();
  }

  return {
    // State
    cwd,
    remote, prs, loading, refreshing, error, errorAction, success, filterState, filterMode,
    currentUser, currentUserLoading, currentUserError,
    showCreateForm, newPrTitle, newPrBody, newPrBase, newPrDraft, newPrReviewers, isCreating,
    forkInfo, newPrBaseRepo,
    mergingPr, mergeMethod,
    selectedPr, prDetail, prChecks, checksWithConflict, prDiffFiles, prComments, prIssueComments, prReviews,
    detailLoading, detailRefreshing, detailError, detailTab, selectedDiffFile, diffMode,
    // CI annotations (v2.18)
    prAnnotations, annotationsLoading, annotationsLoaded,
    annotationCountByCheck, annotationsByFile, loadAnnotations,
    draftReviewComments, showReviewModal, submittingReview,
    conflictPreview, conflictLoading, conflictError,
    hotspots, hotspotsLoading, totalRepoFiles, fileHistory, fileHistoryLoading,
    // Pagination (v2.8.5)
    hasMore, loadingMore,
    // Computed
    forge, forgeLabel,
    commentsForFile, commentCount, mergeReadiness, mergeBlocked, mergeBlockedReason, selectedDiff, displayedPrs,
    // Actions
    init, loadRemote, loadPrs, loadMorePrs, loadCurrentUser, selectPr, loadDiff,
    createPr, checkoutPr, mergePr, convertDraftToReady,
    handleCreateComment, handleReplyComment, handleEditComment,
    handleDeleteComment, handleApplySuggestion, handleAddToReview, handleSubmitReview,
    loadConflictPreview, loadHotspots, loadFileHistory,
    // Helpers
    timeAgo, checkIcon, checksIcon, mergeableIcon, renderBody,
  };
}

export type PrPanelState = ReturnType<typeof usePrPanel>;

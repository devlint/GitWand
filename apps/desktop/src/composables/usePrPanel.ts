/**
 * usePrPanel.ts
 *
 * Singleton composable holding all Pull Request panel state.
 * Instantiated once in App.vue, provided via provide/inject so both
 * PrListSidebar (inside RepoSidebar) and PrDetailView (in <main>)
 * share the same reactive state.
 */
import { ref, computed, watch, type Ref } from "vue";
import {
  ghListPrs,
  ghCreatePr,
  ghCheckoutPr,
  ghMergePr,
  ghPrDetail,
  ghPrDiff,
  ghPrChecks,
  ghPrComments,
  ghPrCreateComment,
  ghPrUpdateComment,
  ghPrDeleteComment,
  ghPrListReviews,
  ghPrSubmitReview,
  ghPrConflictPreview,
  ghPrHotspots,
  gitFileCount,
  ghPrFileHistory,
  gitRemoteInfo,
  type PullRequest,
  type PullRequestDetail,
  type CICheck,
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
} from "../utils/backend";
import { getPersistedDiffMode, type DiffMode } from "../utils/diffMode";

export const PR_PANEL_KEY = Symbol("prPanel");

export function usePrPanel(cwd: Ref<string>) {

  // ─── Remote / list ─────────────────────────────────────
  const remote = ref<RemoteInfo | null>(null);
  const prs = ref<PullRequest[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const success = ref<string | null>(null);
  const filterState = ref<"open" | "closed" | "all">("open");

  // Create PR form
  const showCreateForm = ref(false);
  const newPrTitle = ref("");
  const newPrBody = ref("");
  const newPrBase = ref("");
  const newPrDraft = ref(false);
  const newPrReviewers = ref<string[]>([]);
  const isCreating = ref(false);

  // Merge dialog
  const mergingPr = ref<PullRequest | null>(null);
  const mergeMethod = ref<"merge" | "squash" | "rebase">("merge");

  // ─── Detail ────────────────────────────────────────────
  const selectedPr = ref<PullRequest | null>(null);
  const prDetail = ref<PullRequestDetail | null>(null);
  const prChecks = ref<CICheck[]>([]);
  const prDiffFiles = ref<GitDiff[]>([]);
  const prComments = ref<PrReviewComment[]>([]);
  const prReviews = ref<PrReview[]>([]);
  const detailLoading = ref(false);
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

  // ─── Computed ──────────────────────────────────────────
  const commentsForFile = computed<PrReviewComment[]>(() =>
    selectedDiffFile.value
      ? prComments.value.filter((c) => c.path === selectedDiffFile.value)
      : [],
  );

  const commentCount = computed(() => prComments.value.length);

  const mergeReadiness = computed<{ ready: boolean; reason: string } | null>(() => {
    if (!prReviews.value.length && !prChecks.value.length) return null;
    const checksOk = prChecks.value.length === 0 ||
      prChecks.value.every((c) => {
        const s = (c.conclusion || c.state || "").toUpperCase();
        return ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(s);
      });
    const hasApproval = prReviews.value.some((r) => r.state === "APPROVED");
    const hasChangesRequested = prReviews.value.some((r) => r.state === "CHANGES_REQUESTED");
    if (checksOk && hasApproval && !hasChangesRequested) {
      return { ready: true, reason: "Tous les checks sont verts et la PR est approuvée." };
    }
    const reasons: string[] = [];
    if (!checksOk) reasons.push("checks CI en échec");
    if (!hasApproval) reasons.push("aucune approbation");
    if (hasChangesRequested) reasons.push("modifications demandées");
    return { ready: false, reason: `En attente : ${reasons.join(", ")}.` };
  });

  const selectedDiff = computed<GitDiff | null>(() =>
    selectedDiffFile.value
      ? (prDiffFiles.value.find((f) => f.path === selectedDiffFile.value) ?? null)
      : null,
  );

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
    try { remote.value = await gitRemoteInfo(cwd.value); }
    catch { remote.value = null; }
  }

  async function loadPrs() {
    if (!cwd.value) return;
    loading.value = true;
    error.value = null;
    try {
      prs.value = await ghListPrs(cwd.value, filterState.value);
    } catch (err: any) {
      error.value = err.message;
      prs.value = [];
    } finally {
      loading.value = false;
    }
  }

  function resetDetail() {
    prDetail.value = null;
    prChecks.value = [];
    prDiffFiles.value = [];
    prComments.value = [];
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
    detailLoading.value = true;
    detailError.value = null;
    try {
      const [detail, checks, comments, reviews, fileCount] = await Promise.all([
        ghPrDetail(cwd.value, pr.number),
        ghPrChecks(cwd.value, pr.number).catch(() => [] as CICheck[]),
        ghPrComments(cwd.value, pr.number).catch(() => [] as PrReviewComment[]),
        ghPrListReviews(cwd.value, pr.number).catch(() => [] as PrReview[]),
        gitFileCount(cwd.value).catch(() => 0),
      ]);
      prDetail.value = detail;
      prChecks.value = checks;
      prComments.value = comments;
      prReviews.value = reviews;
      totalRepoFiles.value = fileCount;
    } catch (err: any) {
      detailError.value = err.message;
    } finally {
      detailLoading.value = false;
    }
  }

  async function refreshComments() {
    if (!selectedPr.value) return;
    try {
      prComments.value = await ghPrComments(cwd.value, selectedPr.value.number);
    } catch { /* silent */ }
  }

  async function loadDiff() {
    if (!selectedPr.value || prDiffFiles.value.length) return;
    detailLoading.value = true;
    try {
      const raw = await ghPrDiff(cwd.value, selectedPr.value.number);
      prDiffFiles.value = parseUnifiedDiff(raw);
      if (prDiffFiles.value.length) selectedDiffFile.value = prDiffFiles.value[0].path;
    } catch (err: any) {
      detailError.value = err.message;
    } finally {
      detailLoading.value = false;
    }
  }

  watch(detailTab, async (tab) => {
    if (tab === "diff") loadDiff();
    if (tab === "intelligence") {
      if (prDiffFiles.value.length === 0) await loadDiff();
      if (!hotspots.value.length) loadHotspots();
      if (!Object.keys(fileHistory.value).length) loadFileHistory();
    }
  });

  // Reset when repo changes
  watch(cwd, () => {
    selectedPr.value = null;
    prs.value = [];
    remote.value = null;
    resetDetail();
  });

  // ─── PR actions ─────────────────────────────────────────
  async function createPr() {
    if (!cwd.value || !newPrTitle.value.trim()) return;
    isCreating.value = true;
    error.value = null;
    try {
      const pr = await ghCreatePr(
        cwd.value,
        newPrTitle.value.trim(),
        newPrBody.value.trim(),
        newPrBase.value.trim(),
        newPrDraft.value,
        newPrReviewers.value.slice(),
      );
      success.value = `PR #${pr.number} créée`;
      showCreateForm.value = false;
      newPrTitle.value = ""; newPrBody.value = ""; newPrDraft.value = false;
      newPrReviewers.value = [];
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
    finally { isCreating.value = false; }
  }

  async function checkoutPr(pr: PullRequest) {
    try {
      await ghCheckoutPr(cwd.value, pr.number);
      success.value = `Checkout PR #${pr.number}`;
    } catch (err: any) { error.value = err.message; }
  }

  async function mergePr() {
    if (!mergingPr.value) return;
    try {
      await ghMergePr(cwd.value, mergingPr.value.number, mergeMethod.value);
      success.value = `PR #${mergingPr.value.number} mergée !`;
      mergingPr.value = null;
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
  }

  // ─── Comment actions ────────────────────────────────────
  async function handleCreateComment(params: CreatePrCommentParams & { path: string }) {
    if (!selectedPr.value) return;
    try {
      await ghPrCreateComment(cwd.value, selectedPr.value.number, params);
      await refreshComments();
      if (prDetail.value) prDetail.value.reviewComments++;
    } catch (err: any) { error.value = err.message; }
  }

  async function handleReplyComment(inReplyToId: number, body: string) {
    if (!selectedPr.value) return;
    try {
      await ghPrCreateComment(cwd.value, selectedPr.value.number, { body, in_reply_to_id: inReplyToId });
      await refreshComments();
    } catch (err: any) { error.value = err.message; }
  }

  async function handleEditComment(id: number, body: string) {
    try {
      await ghPrUpdateComment(cwd.value, id, body);
      const idx = prComments.value.findIndex((c) => c.id === id);
      if (idx !== -1) prComments.value[idx] = { ...prComments.value[idx], body, updated_at: new Date().toISOString() };
    } catch (err: any) { error.value = err.message; }
  }

  async function handleDeleteComment(id: number) {
    try {
      await ghPrDeleteComment(cwd.value, id);
      prComments.value = prComments.value.filter((c) => c.id !== id && c.in_reply_to_id !== id);
      if (prDetail.value && prDetail.value.reviewComments > 0) prDetail.value.reviewComments--;
    } catch (err: any) { error.value = err.message; }
  }

  function handleApplySuggestion(suggestion: string, startLine: number | null, endLine: number | null) {
    navigator.clipboard?.writeText(suggestion).catch(() => {});
    success.value = `Suggestion copiée (lignes ${startLine ?? "?"}–${endLine ?? "?"})`;
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
    success.value = `Commentaire ajouté à la review (${draftReviewComments.value.length} en attente)`;
  }

  async function handleSubmitReview(opts: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    comments: PendingReviewComment[];
  }) {
    if (!selectedPr.value) return;
    submittingReview.value = true;
    try {
      await ghPrSubmitReview(cwd.value, selectedPr.value.number, opts);
      showReviewModal.value = false;
      draftReviewComments.value = [];
      const [reviews, comments] = await Promise.all([
        ghPrListReviews(cwd.value, selectedPr.value.number).catch(() => [] as PrReview[]),
        ghPrComments(cwd.value, selectedPr.value.number).catch(() => [] as PrReviewComment[]),
      ]);
      prReviews.value = reviews;
      prComments.value = comments;
      success.value = `Review soumise (${opts.event})`;
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
      conflictPreview.value = await ghPrConflictPreview(cwd.value, selectedPr.value.number);
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
      hotspots.value = await ghPrHotspots(cwd.value, prDiffFiles.value.map((f) => f.path));
    } catch { /* silent */ } finally { hotspotsLoading.value = false; }
  }

  async function loadFileHistory() {
    if (!prDiffFiles.value.length || fileHistoryLoading.value) return;
    fileHistoryLoading.value = true;
    try {
      fileHistory.value = await ghPrFileHistory(cwd.value, prDiffFiles.value.map((f) => f.path));
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
  async function init() {
    await loadRemote();
    await loadPrs();
  }

  return {
    // State
    remote, prs, loading, error, success, filterState,
    showCreateForm, newPrTitle, newPrBody, newPrBase, newPrDraft, newPrReviewers, isCreating,
    mergingPr, mergeMethod,
    selectedPr, prDetail, prChecks, prDiffFiles, prComments, prReviews,
    detailLoading, detailError, detailTab, selectedDiffFile, diffMode,
    draftReviewComments, showReviewModal, submittingReview,
    conflictPreview, conflictLoading, conflictError,
    hotspots, hotspotsLoading, totalRepoFiles, fileHistory, fileHistoryLoading,
    // Computed
    commentsForFile, commentCount, mergeReadiness, selectedDiff,
    // Actions
    init, loadRemote, loadPrs, selectPr, loadDiff,
    createPr, checkoutPr, mergePr,
    handleCreateComment, handleReplyComment, handleEditComment,
    handleDeleteComment, handleApplySuggestion, handleAddToReview, handleSubmitReview,
    loadConflictPreview, loadHotspots, loadFileHistory,
    // Helpers
    timeAgo, checkIcon, checksIcon, mergeableIcon, renderBody,
  };
}

export type PrPanelState = ReturnType<typeof usePrPanel>;

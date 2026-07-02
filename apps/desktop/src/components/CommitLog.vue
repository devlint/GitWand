<script setup lang="ts">
import { computed, ref, watch, inject, nextTick, onMounted, onUnmounted, type Ref } from "vue";
import type { GitLogEntry, GitBranch } from "../utils/backend";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { useI18n } from "../composables/useI18n";
import Avatar from "./Avatar.vue";
import { useAIProvider } from "../composables/useAIProvider";
import { useCommitSearch, filterCommitsLocal, type CommitMatch } from "../composables/useCommitSearch";
import { LOG_FOCUS_SEARCH_KEY } from "../composables/branchPickerBridge";
import AiSparkle from "./AiSparkle.vue";
const { t, locale } = useI18n();

const props = defineProps<{
  entries: GitLogEntry[];
  loading: boolean;
  selectedHash: string | null;
  aheadCount?: number;
  /**
   * True when the current branch has no upstream configured yet.
   * In that case every local commit is effectively "unpushed" because
   * origin does not know about this branch at all.
   */
  needsPublish?: boolean;
  /** True when more commits exist beyond the current page. */
  hasMore?: boolean;
  /** True while the next page is being loaded. */
  loadingMore?: boolean;
  branches?: GitBranch[];
  stashes?: any[];
}>();

/**
 * Effective count of unpushed commits used for styling:
 * - when the branch has no upstream, every local commit is unpushed
 * - otherwise, use aheadCount reported by git status
 */
const effectiveAhead = computed(() =>
  props.needsPublish ? props.entries.length : (props.aheadCount ?? 0),
);

// ─── Virtual scroll ─────────────────────────────────────
const scrollContainerRef = ref<HTMLDivElement | null>(null);

type RowSection =
  | { type: "section-unpushed" }
  | { type: "section-unpublished" }
  | { type: "section-pushed" };

type RowCommit = { type: "commit"; entry: GitLogEntry; originalIndex: number };
type Row = RowSection | RowCommit;

const rows = computed<Row[]>(() => {
  const entries = displayedEntries.value;
  const ahead = effectiveAhead.value;
  const searchActive = isSearchActive.value;
  const showUnpushed = !searchActive && ahead > 0;
  const showPushed = showUnpushed && !props.needsPublish;

  const items: Row[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (showUnpushed && i === 0) {
      items.push(props.needsPublish
        ? { type: "section-unpublished" }
        : { type: "section-unpushed" });
    }
    if (showPushed && i === ahead) {
      items.push({ type: "section-pushed" });
    }
    items.push({ type: "commit", entry: entries[i], originalIndex: i });
  }
  return items;
});

// Estimated row heights used as initial guess before DOM measurement.
// The virtualizer measures actual rendered heights via measureElement, so
// these values only affect the initial scroll-height estimate and the
// position of items before they are painted for the first time.
// Keeping them close to reality avoids visible layout jumps on first render.
const COMMIT_ROW_H = 56; // ~2 text lines + meta row + padding, no refs
const SECTION_ROW_H = 24;

const virtualizer = useVirtualizer({
  count: 0,
  getScrollElement: () => scrollContainerRef.value,
  estimateSize: (index: number) => {
    const row = rows.value[index];
    return row && row.type !== "commit" ? SECTION_ROW_H : COMMIT_ROW_H;
  },
  // Measure each item's actual DOM height after paint so rows with
  // ref badges, AI reason lines, or wrapped messages display at their
  // real height instead of the fixed 72px estimate.
  measureElement: (el) => (el as HTMLElement).offsetHeight,
  overscan: 8,
});

// NOTE: the watcher that syncs `rows.value.length` into the virtualizer
// is declared further down in this file — AFTER `displayedEntries` and
// `isSearchActive` are defined. Putting `{ immediate: true }` here would
// trigger `rows` synchronously, which reads `displayedEntries.value` and
// raises a TDZ ReferenceError because those constants aren't initialized
// yet. See `// ─── virtualizer sync (post-decl) ───` below.

function isSectionRow(row: Row): boolean {
  return row.type !== "commit";
}

function sectionLabelClass(row: Row): string {
  if (row.type === "section-unpublished") return "log-section-label--unpublished";
  if (row.type === "section-unpushed")    return "log-section-label--unpushed";
  if (row.type === "section-pushed")      return "log-section-label--pushed";
  return "";
}

function sectionLabelText(row: Row): string {
  if (row.type === "section-unpublished") return t("log.unpublishedBranch");
  if (row.type === "section-unpushed")    return `${effectiveAhead.value} ${effectiveAhead.value === 1 ? t("log.unpushedOne") : t("log.unpushedMany")}`;
  if (row.type === "section-pushed")      return t("log.pushed");
  return "";
}

function vrStyle(vr: { start: number; size: number }) {
  // height: vr.size keeps items from overlapping during the estimate phase.
  // measureElement is attached to the INNER content elements (commit-item /
  // log-section-label), not this wrapper — so offsetHeight reads the true
  // content height, not the explicitly-set wrapper height. On the next render
  // vr.size is corrected to the measured value and the wrapper matches the
  // content exactly. overflow: visible lets content show even if it briefly
  // exceeds the estimate before the first measurement lands.
  return {
    position: "absolute" as const,
    top: 0,
    left: 0,
    width: "100%",
    height: vr.size + "px",
    overflow: "visible" as const,
    transform: "translateY(" + vr.start + "px)",
  };
}

/** Get commit entry from row index (only use inside v-else where row is guaranteed commit). */
function c(index: number): GitLogEntry {
  return (rows.value[index] as RowCommit).entry;
}

/** Get original displayedEntries index from row index. */
function oi(index: number): number {
  return (rows.value[index] as RowCommit).originalIndex;
}

const emit = defineEmits<{
  selectCommit: [hash: string];
  editCommit: [entry: GitLogEntry];
  splitCommit: [entry: GitLogEntry];
  // v1.9 — commit context menu
  checkoutCommit: [entry: GitLogEntry];
  checkoutBranch: [name: string];
  resetToCommit: [entry: GitLogEntry, mode?: "soft" | "mixed" | "hard"];
  revertCommit: [entry: GitLogEntry];
  createBranchFromCommit: [entry: GitLogEntry];
  tagCommit: [entry: GitLogEntry];
  cherryPickCommit: [entry: GitLogEntry];
  viewOnForge: [entry: GitLogEntry];
  deleteBranch: [name: string, hasLocal: boolean, hasRemote: boolean, remoteName?: string];
  deleteTag: [name: string, hasLocal: boolean, hasRemote: boolean];
  applyStash: [index: number];
  popStash: [index: number];
  dropStash: [index: number];
  /** User scrolled near the bottom — request more commits. */
  loadMore: [];
}>();

// ─── Context menu on commit items ─────────────────────────
// Right-click on a commit opens a small menu with the "Split commit…" action.
// The actual split workflow is owned by the host (App.vue); here we only
// surface the user intent via the `splitCommit` emit.
interface CommitCtxMenu {
  visible: boolean;
  x: number;
  y: number;
  entry: GitLogEntry | null;
  /** Index in the displayed list — used to restrict some actions to HEAD. */
  idx: number;
  /** The specific branch name that was right-clicked (if any). */
  clickedBranch?: string;
  /** The type of ref that was right-clicked (if any). */
  clickedBranchType?: "head" | "branch" | "remote" | "tag" | "stash";
  /** The specific tag name that was right-clicked (if any). */
  clickedTag?: string;
  /** The specific stash index that was right-clicked (if any). */
  clickedStashIndex?: number;
}
const ctxMenu = ref<CommitCtxMenu>({ visible: false, x: 0, y: 0, entry: null, idx: -1 });

const currentBranchName = computed(() => props.branches?.find(b => b.isCurrent)?.name);

function openCommitContextMenu(e: MouseEvent, entry: GitLogEntry, idx: number, branchName?: string, branchType?: any) {
  e.preventDefault();
  e.stopPropagation();
  // Select the commit first — the user expects the diff view to reflect what
  // they right-clicked on.
  emit("selectCommit", entry.hashFull);
  const tag = branchType === "tag" ? branchName : undefined;

  // Identify if this is a stash commit
  let stashIdx: number | undefined;
  if (branchType === "stash" || entry.refs.includes("refs/stash")) {
    const stash = props.stashes?.find((s) => s.hash === entry.hashFull);
    if (stash) stashIdx = stash.index;
  }

  // If no branchName provided, pick a candidate branch from the commit refs if any (v2.14)
  let finalBranchName = branchName;
  let finalBranchType = branchType;

  if (!finalBranchName && !tag && stashIdx === undefined) {
    const badges = parseRefBadges(entry.refs);
    const branchesAtCommit = badges.filter(b => b.type === 'head' || b.type === 'branch' || b.type === 'remote');
    if (branchesAtCommit.length > 0) {
      // Prioritize branches that are NOT the current one
      const notCurrent = branchesAtCommit.find(b => b.label !== currentBranchName.value);
      const candidate = notCurrent || branchesAtCommit[0];
      finalBranchName = candidate.label;
      finalBranchType = candidate.type;
    }
  }

  ctxMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    entry,
    idx,
    clickedBranch: finalBranchName,
    clickedBranchType: finalBranchType || (stashIdx !== undefined ? "stash" : undefined),
    clickedTag: tag,
    clickedStashIndex: stashIdx,
  };
}

/**
 * True when the checkout action should be disabled:
 * - We are already on the branch being clicked
 * - Or we are checking out a commit that is already HEAD (and no specific branch was clicked)
 */
const isCheckoutDisabled = computed(() => {
  if (!ctxMenu.value.entry) return true;
  if (ctxMenu.value.clickedBranch) {
    return ctxMenu.value.clickedBranch === currentBranchName.value;
  }
  return isCtxEntryHead.value;
});

function closeCommitContextMenu() {
  ctxMenu.value.visible = false;
}

function onCtxSplit() {
  if (!ctxMenu.value.entry) return;
  if (isCtxEntryMerge.value) return;
  emit("splitCommit", ctxMenu.value.entry);
  closeCommitContextMenu();
}

function onBranchDblClick(badge: { type: string, label: string }) {
  window.getSelection()?.removeAllRanges();
  if (badge.type === 'tag' || badge.type === 'stash') return;
  const name = badge.type === 'remote'
    ? badge.label.slice(badge.label.indexOf('/') + 1)
    : badge.label;
  emit('checkoutBranch', name);
}

function onRowDblClick(entry: GitLogEntry) {
  if (isCurrent(entry)) return;
  const badges = parseRefBadges(entry.refs);
  const branch = badges.find(b => b.type === 'head' || b.type === 'branch') ?? badges.find(b => b.type === 'remote');
  if (!branch) return;
  onBranchDblClick(branch);
}

function onCtxEmit(event: "checkoutCommit" | "resetToCommit" | "revertCommit" | "createBranchFromCommit" | "tagCommit" | "cherryPickCommit" | "viewOnForge") {
  const entry = ctxMenu.value.entry;
  if (!entry) return;
  if (event === "checkoutCommit")         emit("checkoutCommit", entry);
  else if (event === "resetToCommit")     emit("resetToCommit", entry);
  else if (event === "revertCommit")      emit("revertCommit", entry);
  else if (event === "createBranchFromCommit") emit("createBranchFromCommit", entry);
  else if (event === "tagCommit")         emit("tagCommit", entry);
  else if (event === "cherryPickCommit")  emit("cherryPickCommit", entry);
  else if (event === "viewOnForge")       emit("viewOnForge", entry);
  closeCommitContextMenu();
}

async function onCtxCopySha(full: boolean) {
  const sha = full ? ctxMenu.value.entry?.hashFull : ctxMenu.value.entry?.hash;
  if (sha) await navigator.clipboard.writeText(sha);
  closeCommitContextMenu();
}

async function onCtxCopyBranchName() {
  if (ctxMenu.value.clickedBranch) {
    await navigator.clipboard.writeText(ctxMenu.value.clickedBranch);
  }
  closeCommitContextMenu();
}

async function onCtxCopySummary() {
  const entry = ctxMenu.value.entry;
  if (entry) await navigator.clipboard.writeText(entry.message);
  closeCommitContextMenu();
}

async function onCtxCopyDescription() {
  const entry = ctxMenu.value.entry;
  if (entry?.body) await navigator.clipboard.writeText(entry.body);
  closeCommitContextMenu();
}

async function onCtxCopyMessage() {
  const entry = ctxMenu.value.entry;
  if (!entry) return;
  const text = entry.body ? `${entry.message}\n\n${entry.body}` : entry.message;
  await navigator.clipboard.writeText(text);
  closeCommitContextMenu();
}

const branchToDelete = computed(() => {
  if (!ctxMenu.value.clickedBranch || !props.branches) return null;
  const name = ctxMenu.value.clickedBranch;
  const type = ctxMenu.value.clickedBranchType;

  if (type === "branch" || type === "head") {
    // Standard local branch (or current branch HEAD -> ...)
    const local = props.branches.find((b) => b.name === name && !b.isRemote);
    if (!local) {
      // Fallback: assume it's a local branch if the log says so
      return { name, localName: name, hasLocal: true, hasRemote: false };
    }
    const remote = props.branches.find(
      (b) => b.isRemote && (b.name === `origin/${name}` || b.name === local.upstream),
    );
    return { name, localName: name, remoteName: remote?.name, hasLocal: true, hasRemote: !!remote };
  } else if (type === "remote") {
    // Remote tracking branch (e.g. origin/main)
    const remote = props.branches.find((b) => b.name === name && b.isRemote);
    // Extract base name from remote name (e.g. origin/main -> main)
    const slashIdx = name.indexOf("/");
    const baseName = slashIdx !== -1 ? name.slice(slashIdx + 1) : name;

    if (!remote) {
      // Fallback: assume it's a remote branch even if not in props.branches
      return { name: baseName, remoteName: name, hasLocal: false, hasRemote: true };
    }

    const local = props.branches.find((b) => !b.isRemote && (b.name === baseName || b.upstream === name));
    return {
      name: baseName,
      localName: local?.name,
      remoteName: name,
      hasLocal: !!local,
      hasRemote: true,
    };
  }
  return null;
});

function onCtxDeleteBranch() {
  const b = branchToDelete.value;
  if (!b) return;
  emit("deleteBranch", b.name, b.hasLocal, b.hasRemote, b.remoteName);
  closeCommitContextMenu();
}

const tagToDelete = computed(() => {
  if (!ctxMenu.value.clickedTag) return null;
  return { name: ctxMenu.value.clickedTag, hasLocal: true, hasRemote: true };
});

function onCtxDeleteTag() {
  const t = tagToDelete.value;
  if (!t) return;
  emit("deleteTag", t.name, t.hasLocal, t.hasRemote);
  closeCommitContextMenu();
}

/** True when the commit under the context menu is a merge (>1 parent). */
const isCtxEntryMerge = computed(
  () => (ctxMenu.value.entry?.parents?.length ?? 0) > 1,
);

/**
 * True when the commit under the context menu is the topmost displayed entry
 * AND search is not active. In search mode idx=0 is not necessarily HEAD, so
 * we conservatively disable actions that require HEAD (Amend, Split).
 */
const isCtxEntryHead = computed(() => !isSearchActive.value && ctxMenu.value.idx === 0);

onMounted(() => {
  window.addEventListener("click", closeCommitContextMenu);
  window.addEventListener("contextmenu", closeCommitContextMenu, { capture: false });
  window.addEventListener("keydown", onCtxKey);
});
onUnmounted(() => {
  window.removeEventListener("click", closeCommitContextMenu);
  window.removeEventListener("contextmenu", closeCommitContextMenu, { capture: false } as EventListenerOptions);
  window.removeEventListener("keydown", onCtxKey);
});

function onCtxKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeCommitContextMenu();
}

// ─── Infinite scroll — load next page when user reaches the bottom ─
// Uses a scroll listener on the virtualizer's scroll container.
// Emits `load-more` once per page when scrolled within 200px of bottom.
let _loadMorePending = false;

function onLogScroll() {
  if (!props.hasMore || props.loadingMore || _loadMorePending) return;
  const el = scrollContainerRef.value;
  if (!el) return;
  const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (remaining < 200) {
    _loadMorePending = true;
    emit("loadMore");
    // Reset pending flag once entries grow (watch catches it)
  }
}

watch(() => props.entries.length, () => {
  _loadMorePending = false;
});

// ─── Search (Phase 1.3.4) ─────────────────────────────────
const ai = useAIProvider();
const { isSearching: isAiSearching, searchAI, lastError: aiSearchError } = useCommitSearch();
const searchQuery = ref("");
const aiMatches = ref<CommitMatch[] | null>(null);
const searchInputEl = ref<HTMLInputElement | null>(null);

// External focus trigger (native Edit menu → Find in Log). Each bump of
// the injected counter focuses + selects the search input. App.vue is
// expected to switch viewMode to "history" before bumping so the input
// is actually mounted.
const focusRequest = inject<Ref<number> | null>(LOG_FOCUS_SEARCH_KEY, null);
if (focusRequest) {
  watch(focusRequest, () => {
    nextTick(() => {
      const el = searchInputEl.value;
      if (!el) return;
      el.focus();
      el.select();
    });
  });
}

const displayedEntries = computed<GitLogEntry[]>(() => {
  if (aiMatches.value !== null) return aiMatches.value.map((m) => m.entry);
  return filterCommitsLocal(props.entries, searchQuery.value);
});

const isSearchActive = computed(
  () => aiMatches.value !== null || searchQuery.value.trim().length > 0,
);

// ─── virtualizer sync (post-decl) ─────────────────────────
// Moved here so `{ immediate: true }` doesn't fire before
// `displayedEntries` / `isSearchActive` (which `rows` depends on) are
// initialized — see comment near the virtualizer declaration above.
watch(() => rows.value.length, (count) => {
  virtualizer.value?.setOptions({
    ...virtualizer.value.options,
    count,
  });
}, { immediate: true });

/** Hashes of the commits considered "unpushed" in the original list. */
const unpushedHashes = computed<Set<string>>(() => {
  const set = new Set<string>();
  const ahead = props.needsPublish ? props.entries.length : (props.aheadCount ?? 0);
  for (let i = 0; i < ahead; i++) {
    const e = props.entries[i];
    if (e) set.add(e.hashFull);
  }
  return set;
});

function isUnpushed(entry: GitLogEntry): boolean {
  return unpushedHashes.value.has(entry.hashFull);
}

const reasonByHash = computed(() => {
  const map = new Map<string, string>();
  if (aiMatches.value) {
    for (const m of aiMatches.value) {
      if (m.reason) map.set(m.entry.hashFull, m.reason);
    }
  }
  return map;
});

async function runAiSearch() {
  if (!searchQuery.value.trim()) return;
  try {
    const matches = await searchAI(searchQuery.value, props.entries, {
      locale: locale.value,
    });
    aiMatches.value = matches;
  } catch {
    // surfaced via aiSearchError
  }
}

function clearSearch() {
  searchQuery.value = "";
  aiMatches.value = null;
}

// Clear AI match set when the query changes (typing invalidates the
// prior AI result — the user is refining).
watch(searchQuery, () => {
  aiMatches.value = null;
});

interface RefBadge { type: "head" | "branch" | "remote" | "tag" | "stash"; label: string; }

function parseRefBadges(refs: string): RefBadge[] {
  if (!refs) return [];
  const parsed = refs.split(",").map(r => r.trim()).filter(Boolean).map(r => {
    if (r.startsWith("HEAD -> ")) return { type: "head" as const, label: r.slice(8) };
    if (r === "HEAD") return { type: "head" as const, label: "HEAD" };
    if (r.startsWith("tag: ")) return { type: "tag" as const, label: r.slice(5) };
    if (r === "refs/stash") return { type: "stash" as const, label: "stash" };
    if (r.includes("/")) return { type: "remote" as const, label: r };
    return { type: "branch" as const, label: r };
  });

  // Re-classify refs using props.branches (v2.14)
  // parseRefBadges is generic and thinks anything with a '/' is remote.
  // We use our ground-truth branches list to fix this.
  const reclassified = parsed.map(r => {
    if (r.type === 'branch' || r.type === 'remote') {
      const match = props.branches?.find(b => b.name === r.label);
      if (match) {
        return { ...r, type: (match.isRemote ? 'remote' : 'branch') as 'remote' | 'branch' };
      }
    }
    return r;
  });

  // Filter out redundant remote tracking branches and noise (v2.14)
  // If we have 'main' (branch) and 'origin/main' (remote) at the same commit,
  // hide the remote one to keep the tree row clean.
  const localBranchNames = new Set(reclassified.filter(r => r.type === 'head' || r.type === 'branch').map(r => r.label));
  const filtered = reclassified.filter(r => {
    // Hide origin/HEAD (noise)
    if (r.label === 'origin/HEAD') return false;

    if (r.type === 'remote') {
      const slashIdx = r.label.indexOf('/');
      if (slashIdx !== -1) {
        const baseName = r.label.slice(slashIdx + 1);
        if (localBranchNames.has(baseName)) return false;
      }
      // Also check against local branches that might have the same name as upstream
      const match = props.branches?.find(b => b.name === r.label && b.isRemote);
      if (match) {
        // Find if any local branch has this remote as its upstream
        const hasLocalUpstream = props.branches?.some(b => !b.isRemote && b.upstream === r.label && localBranchNames.has(b.name));
        if (hasLocalUpstream) return false;
      }
    }
    return true;
  });

  // Sort: Local Branch (head/branch) > Remote > Tag > Stash > HEAD (detached)
  // Note: in CommitLog, "HEAD -> branch" is typed as "head" with the branch name as label.
  const weights: Record<string, number> = {
    head: 1,
    branch: 1,
    remote: 2,
    tag: 3,
    stash: 4,
  };

  return filtered.sort((a, b) => {
    // Special case: detached "HEAD" should be last
    if (a.label === "HEAD" && a.type === "head") return 1;
    if (b.label === "HEAD" && b.type === "head") return -1;
    return (weights[a.type] ?? 99) - (weights[b.type] ?? 99);
  });
}

function truncate(str: string, limit = 20) {
  if (str.length <= limit) return str;
  return str.slice(0, limit - 1) + "…";
}

function relativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return t('date.now');
  if (diffMin < 60) return t('date.minutesAgo', diffMin);
  if (diffHour < 24) return t('date.hoursAgo', diffHour);
  if (diffDay < 7) return t('date.daysAgo', diffDay);
  if (diffDay < 30) return t('date.weeksAgo', Math.floor(diffDay / 7));
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function isCurrent(entry: GitLogEntry): boolean {
  return parseRefBadges(entry.refs).some(b => b.type === "head");
}

function abbrevAuthor(author: string): string {
  if (!author) return "";
  const parts = author.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 12);
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
</script>

<template>
  <div class="commit-log">
    <!-- Search bar -->
    <div v-if="entries.length > 0" class="log-search">
      <svg class="log-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.4"/>
        <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <input
        ref="searchInputEl"
        v-model="searchQuery"
        type="text"
        class="log-search-input"
        :placeholder="t('log.searchPlaceholder')"
        @keydown.enter.prevent="runAiSearch"
        @keydown.esc.prevent="clearSearch"
      />
      <button
        v-if="ai.isAvailable.value && searchQuery.trim()"
        type="button"
        class="btn btn--ai btn--icon"
        :disabled="isAiSearching"
        :title="t('log.searchAiHint')"
        :aria-label="t('log.searchAiHint')"
        @click="runAiSearch"
      >
        <span v-if="isAiSearching">…</span>
        <AiSparkle v-else :size="16" />
      </button>
      <button
        v-if="searchQuery || aiMatches !== null"
        type="button"
        class="log-search-clear"
        :title="t('common.close')"
        @click="clearSearch"
      >✕</button>
    </div>
    <p v-if="aiSearchError" class="log-search-error">{{ aiSearchError }}</p>
    <p v-if="aiMatches !== null" class="log-search-status">
      <AiSparkle :size="13" :animated="false" />
      {{ t('log.aiSearchResults', displayedEntries.length) }}
    </p>

    <div class="log-loading" v-if="loading">
      <div class="loading-spinner"></div>
      <span class="muted">{{ t('common.loading') }}</span>
    </div>

    <div ref="scrollContainerRef" class="log-list" v-else-if="displayedEntries.length > 0" @scroll.passive="onLogScroll">
      <div :style="{ height: virtualizer.getTotalSize() + 'px', position: 'relative', width: '100%' }">
        <div
          v-for="vr in virtualizer.getVirtualItems()"
          :key="'' + vr.key"
          :style="vrStyle(vr)"
        >
          <template v-if="isSectionRow(rows[vr.index])">
            <div
              class="log-section-label"
              :class="sectionLabelClass(rows[vr.index])"
              :data-index="vr.index"
              :ref="(el) => { if (el) virtualizer.measureElement(el as Element); }"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>{{ sectionLabelText(rows[vr.index]) }}</span>
            </div>
          </template>
          <template v-else>
            <div
              class="commit-item"
              :data-index="vr.index"
              :ref="(el) => { if (el) virtualizer.measureElement(el as Element); }"
              :class="{
                'commit-item--selected': selectedHash === c(vr.index).hashFull,
                'commit-item--unpushed': isUnpushed(c(vr.index)),
                'commit-item--current': isCurrent(c(vr.index)),
              }"
              @click="emit('selectCommit', c(vr.index).hashFull)"
              @dblclick="onRowDblClick(c(vr.index))"
              @contextmenu="openCommitContextMenu($event, c(vr.index), oi(vr.index))"
              tabindex="0"
              @keydown.enter="emit('selectCommit', c(vr.index).hashFull)"
            >
              <Avatar class="commit-avatar" :name="c(vr.index).author" :email="c(vr.index).email" />
              <div class="commit-info">
                <div class="commit-message">
                  {{ c(vr.index).message }}
                  <span v-if="isUnpushed(c(vr.index))" class="unpushed-badge">{{ needsPublish ? t('log.unpublishedBadge') : 'unpushed' }}</span>
                </div>
                <div v-if="reasonByHash.get(c(vr.index).hashFull)" class="commit-ai-reason">
                  <AiSparkle :size="12" :animated="false" />
                  <span>{{ reasonByHash.get(c(vr.index).hashFull) }}</span>
                </div>
                <div class="commit-meta">
                  <span class="commit-hash mono">{{ c(vr.index).hash }}</span>
                  <span class="commit-separator" aria-hidden="true">&middot;</span>
                  <span class="commit-author" :title="c(vr.index).author">{{ abbrevAuthor(c(vr.index).author) }}</span>
                  <span class="commit-separator" aria-hidden="true">&middot;</span>
                  <time class="commit-date" :datetime="c(vr.index).date">{{ relativeDate(c(vr.index).date) }}</time>
                </div>
                <div v-if="!isSearchActive && c(vr.index).refs" class="commit-refs">
                  <template v-for="(badgeList, r_key) in { list: parseRefBadges(c(vr.index).refs) }" :key="r_key">
                    <span
                      v-for="badge in badgeList"
                      :key="badge.label"
                      class="log-badge"
                      :class="`log-badge--${badge.type}`"
                      :title="badge.label"
                      @contextmenu.stop="openCommitContextMenu($event, c(vr.index), vr.index, badge.label, badge.type)"
                      @dblclick.stop="onBranchDblClick(badge)"
                    >
                      {{ badgeList.length > 1 ? truncate(badge.label) : badge.label }}
                    </span>
                  </template>

              <button
                v-if="!isSearchActive && aheadCount != null && oi(vr.index) === 0"
                class="commit-edit-btn"
                @click.stop="emit('editCommit', c(vr.index))"
                :title="t('log.editMessage')"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </template>
        </div>
      </div>
      <!-- Load-more sentinel (v2.11): shown below virtual list when more pages exist -->
      <div v-if="hasMore" class="log-load-more">
        <span v-if="loadingMore" class="log-load-more__spinner" aria-label="Loading more commits"></span>
        <span class="muted" style="font-size:11px">{{ loadingMore ? 'Loading more…' : 'Scroll for more' }}</span>
      </div>
    </div>

    <div class="log-empty" v-else>
      <span class="muted">{{ t('log.noCommit') }}</span>
    </div>

    <!-- Context menu for commit items (right-click) -->
    <Teleport to="body">
      <ul
        v-if="ctxMenu.visible"
        class="commit-ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        role="menu"
        @click.stop
        @contextmenu.prevent
        >
        <!-- Stash actions (v2.12) — shown ONLY for stash commits -->
        <template v-if="ctxMenu.clickedBranchType === 'stash' && ctxMenu.clickedStashIndex !== undefined">
          <li
            class="commit-ctx-menu-item"
            role="menuitem"
            @click="emit('applyStash', ctxMenu.clickedStashIndex!); closeCommitContextMenu()"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 11 12 14 22 4"></polyline>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
            </svg>
            <span>{{ t('stash.applyStash') }}</span>
          </li>
          <li
            class="commit-ctx-menu-item"
            role="menuitem"
            @click="emit('popStash', ctxMenu.clickedStashIndex!); closeCommitContextMenu()"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
            <span>{{ t('stash.popStash') }}</span>
          </li>
          <li
            class="commit-ctx-menu-item commit-ctx-menu-item--danger"
            role="menuitem"
            @click="emit('dropStash', ctxMenu.clickedStashIndex!); closeCommitContextMenu()"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4M6 7v5M10 7v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>{{ t('stash.dropStash') }}</span>
          </li>
        </template>

        <!-- Standard git actions — hidden for stashes -->
        <template v-else>
          <!-- Navigation -->
          <li
            class="commit-ctx-menu-item"
            :class="{ 'commit-ctx-menu-item--disabled': isCheckoutDisabled }"
            role="menuitem"
            :title="isCheckoutDisabled ? t('commitCtx.checkoutHeadDisabled') : t('commitCtx.checkoutHint')"
            @click="!isCheckoutDisabled && (ctxMenu.clickedBranch ? onBranchDblClick({ type: ctxMenu.clickedBranchType || 'branch', label: ctxMenu.clickedBranch }) : onCtxEmit('checkoutCommit'))"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/>
              <path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
            <span>{{ ctxMenu.clickedBranch ? t('commitCtx.checkoutBranch') : t('commitCtx.checkout') }}</span>
          </li>

          <li
            v-if="ctxMenu.clickedBranch"
            class="commit-ctx-menu-item"
            :class="{ 'commit-ctx-menu-item--disabled': isCtxEntryHead }"
            role="menuitem"
            :title="isCtxEntryHead ? t('commitCtx.checkoutHeadDisabled') : t('commitCtx.checkoutHint')"
            @click="!isCtxEntryHead && onCtxEmit('checkoutCommit')"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/>
              <path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
            <span>{{ t('commitCtx.checkout') }}</span>
          </li>
        <li
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxEmit('resetToCommit')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8a5 5 0 1 0 1.5-3.5L2 2v4h4L4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('commitCtx.reset') }}</span>
        </li>

        <li class="commit-ctx-menu-sep" role="separator"></li>

        <!-- Branching -->
        <li
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxEmit('createBranchFromCommit')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 2v8m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm8-4a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 0v2a2 2 0 0 1-2 2H6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('commitCtx.createBranch') }}</span>
        </li>
        <li
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxEmit('tagCommit')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 2h6l6 6-6 6-6-6V2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            <circle cx="5.5" cy="5.5" r="1" fill="currentColor"/>
          </svg>
          <span>{{ t('commitCtx.tag') }}</span>
        </li>
        <li
          class="commit-ctx-menu-item"
          :class="{ 'commit-ctx-menu-item--disabled': isCtxEntryHead }"
          role="menuitem"
          :title="isCtxEntryHead ? t('commitCtx.cherryPickHeadDisabled') : undefined"
          @click="!isCtxEntryHead && onCtxEmit('cherryPickCommit')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="5" cy="13" r="2" stroke="currentColor" stroke-width="1.4"/>
            <circle cx="11" cy="13" r="2" stroke="currentColor" stroke-width="1.4"/>
            <path d="M5 11V7a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <path d="M8 4V1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <span>{{ t('commitCtx.cherryPick') }}</span>
        </li>

        <!-- Branch Deletion (v2.12) -->
        <template v-if="branchToDelete">
          <li class="commit-ctx-menu-sep" role="separator"></li>
          <li
            class="commit-ctx-menu-item commit-ctx-menu-item--danger"
            role="menuitem"
            @click="onCtxDeleteBranch"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>{{ t('branchMenu.deleteLabel') }}</span>
          </li>
        </template>

        <!-- Tag Deletion (v2.12) -->
        <template v-if="tagToDelete">
          <li class="commit-ctx-menu-sep" role="separator"></li>
          <li
            class="commit-ctx-menu-item commit-ctx-menu-item--danger"
            role="menuitem"
            @click="onCtxDeleteTag"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>{{ t('tags.deleteTag') }}</span>
          </li>
        </template>
            <li class="commit-ctx-menu-sep" role="separator"></li>
        <!-- History operations -->
        <li
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxEmit('revertCommit')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <path d="M5 1L2 4l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('commitCtx.revert') }}</span>
        </li>
        <li
          class="commit-ctx-menu-item"
          :class="{ 'commit-ctx-menu-item--disabled': !isCtxEntryHead }"
          role="menuitem"
          :title="!isCtxEntryHead ? t('commitCtx.amendHeadOnly') : undefined"
          @click="isCtxEntryHead && ctxMenu.entry && (emit('editCommit', ctxMenu.entry), closeCommitContextMenu())"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('commitCtx.amend') }}</span>
        </li>
        <li
          class="commit-ctx-menu-item"
          :class="{ 'commit-ctx-menu-item--disabled': isCtxEntryMerge || !isCtxEntryHead }"
          role="menuitem"
          :title="isCtxEntryMerge ? t('splitCommit.errorMergeCommit') : !isCtxEntryHead ? t('commitCtx.splitHeadOnly') : undefined"
          @click="onCtxSplit"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2v5m0 0l-3-3m3 3l3-3M3 10h10M5 14h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('splitCommit.contextMenuAction') }}</span>
        </li>

        <li class="commit-ctx-menu-sep" role="separator"></li>

        <!-- Clipboard -->
        <li class="commit-ctx-menu-item" role="menuitem" @click="onCtxCopySha(false)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5" y="4" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M3 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <span>{{ t('commitCtx.copyShortSha') }}</span>
        </li>
        <li class="commit-ctx-menu-item" role="menuitem" @click="onCtxCopySha(true)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5" y="4" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M3 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <path d="M8 8h3M8 11h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          <span>{{ t('commitCtx.copyFullSha') }}</span>
        </li>
        <li
          v-if="ctxMenu.clickedBranch"
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxCopyBranchName"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 2v8m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm8-4a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('commitCtx.copyBranchName') }}</span>
        </li>
        <li class="commit-ctx-menu-item" role="menuitem" @click="onCtxCopySummary">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h12v8H2z" rx="1" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            <path d="M5 7h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          <span>{{ t('commitCtx.copySummary') }}</span>
        </li>
        <li
          v-if="ctxMenu.entry?.body"
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxCopyDescription"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h12v8H2z" rx="1" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            <path d="M5 7h6M5 10h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          <span>{{ t('commitCtx.copyDescription') }}</span>
        </li>
        <li class="commit-ctx-menu-item" role="menuitem" @click="onCtxCopyMessage">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h12v8H2z" rx="1" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            <path d="M5 7h6M5 10h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          <span>{{ t('commitCtx.copyMessage') }}</span>
        </li>

        <li class="commit-ctx-menu-sep" role="separator"></li>

        <!-- Forge -->
        <li
          class="commit-ctx-menu-item"
          role="menuitem"
          @click="onCtxEmit('viewOnForge')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 2h4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14 2L8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <span>{{ t('commitCtx.viewOnForge') }}</span>
      </li>
      </template>
    </ul>
  </Teleport>
</template>

<style scoped>
.commit-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.log-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.log-list {
  list-style: none;
  flex: 1;
  overflow-y: auto;
}

/* ─── Section labels ──────────────────────────────────── */

.log-section-label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-4);
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 1;
}

.log-section-label--unpushed {
  color: var(--color-warning);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-warning);
}

.log-section-label--unpublished {
  color: var(--color-accent);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-accent);
}

.log-section-label--pushed {
  color: var(--color-success);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-success);
}

/* ─── Commit item ─────────────────────────────────────── */

.commit-item {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background var(--transition-fast);
  border-left: 3px solid transparent;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.commit-item--unpushed {
  border-left-color: var(--color-warning);
  background: var(--color-warning-soft);
}

.commit-item--unpushed:hover {
  background: var(--color-warning-soft);
  opacity: 0.9;
}

.unpushed-badge {
  display: inline-block;
  font-size: 9px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  margin-left: var(--space-1);
  vertical-align: middle;
}

.commit-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.commit-item--selected {
  background: rgba(139, 92, 246, 0.22) !important;
  border-left-color: var(--color-accent);
}

.commit-item--selected:hover {
  background: rgba(139, 92, 246, 0.28) !important;
}

.commit-item--current {
  background: rgba(139, 92, 246, 0.12);
}

.commit-item--current:hover {
  background: rgba(139, 92, 246, 0.18);
  opacity: 1;
}

.commit-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
  background: rgba(255, 255, 255, 0.04);
}

.commit-item:last-child {
  border-bottom: none;
}

.commit-edit-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
  align-self: center;
}

.commit-item:hover .commit-edit-btn {
  opacity: 0.7;
}

.commit-edit-btn:hover {
  opacity: 1 !important;
  color: var(--color-accent);
  background: var(--color-bg);
}

.commit-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  flex-shrink: 0;
  margin-top: 2px;
}

.commit-info {
  flex: 1;
  min-width: 0;
}

.commit-message {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: 3px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.commit-hash {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
}

.commit-separator {
  opacity: 0.4;
}

.commit-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-date {
  flex-shrink: 0;
}

.log-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-10);
}

/* ─── Search bar (Phase 1.3.4) ────────────────────────────── */
.log-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.log-search-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.log-search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  padding: 2px 0;
}

.log-search-input::placeholder {
  color: var(--color-text-muted);
}

.log-search-clear {
  flex-shrink: 0;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-xs);
}

.log-search-clear:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
}

.log-search-error,
.log-search-status {
  margin: 0;
  padding: 6px var(--space-3);
  font-size: var(--font-size-xs);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 6px;
}

.log-search-error {
  color: var(--color-danger, #ef4444);
  background: var(--color-danger-soft, rgba(239, 68, 68, 0.06));
}

.log-search-status {
  color: var(--color-accent);
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.06));
}

.commit-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 3px;
}

.log-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: var(--font-weight-medium);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-badge--head,
.log-badge--branch {
  background: var(--color-bg);
  color: var(--color-accent);
  border: 1px solid var(--color-accent);
}

.log-badge--tag {
  background: #ffffff;
  color: #000000;
  border: 1px solid #ffffff;
  text-shadow: none;
}

.log-badge--stash {
  background: var(--color-bg);
  color: var(--color-warning, #f59e0b);
  border: 1px dashed var(--color-warning, #f59e0b);
}

.log-badge--remote {
  background: var(--color-bg);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}

.commit-ai-reason {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  line-height: 1.3;
  display: flex;
  align-items: flex-start;
  gap: 5px;
}

/* ─── Load-more sentinel (v2.11) ───────────────────────── */
.log-load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 0 12px;
}

.log-load-more__spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ll-spin 0.7s linear infinite;
  opacity: 0.5;
}

@keyframes ll-spin { to { transform: rotate(360deg); } }
</style>

<style>
/* Teleported menu — unscoped so the styles apply after mounting to <body>. */
.commit-ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 8px 20px rgba(0, 0, 0, 0.18));
  font-size: var(--font-size-sm);
}

.commit-ctx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
}

.commit-ctx-menu-item:hover {
  background: var(--color-bg-tertiary);
}

.commit-ctx-menu-item svg {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.commit-ctx-menu-item--danger:hover {
  background: var(--color-danger-soft, rgba(220, 38, 38, 0.12));
  color: var(--color-danger, #dc2626);
}

.commit-ctx-menu-item--danger:hover svg {
  color: var(--color-danger, #dc2626);
}

.commit-ctx-menu-item--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.commit-ctx-menu-item--disabled:hover {
  background: transparent;
}

.commit-ctx-menu-sep {
  height: 1px;
  background: var(--color-border);
  margin: 3px 6px;
  list-style: none;
}
</style>

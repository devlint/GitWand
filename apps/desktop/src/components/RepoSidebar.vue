<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { type RepoFileEntry, type ViewMode } from "../composables/useGitRepo";
import type { GitLogEntry, GitBranch } from "../utils/backend";
import CommitLog from "./CommitLog.vue";
import PrListSidebar from "./PrListSidebar.vue";
import { useI18n } from "../composables/useI18n";
import { useCommitMessage } from "../composables/useCommitMessage";
import { useAIProvider } from "../composables/useAIProvider";
import { supportedLocales, localeLabels } from "../locales";
import { useAbsorb, type AbsorbCandidate } from "../composables/useAbsorb";

const props = defineProps<{
  /** Repo directory, used by AI commit message generation. */
  cwd: string;
  files: RepoFileEntry[];
  selectedFile: string | null;
  viewMode: ViewMode;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number };
  commitSummary: string;
  commitDescription: string;
  canCommit: boolean;
  isCommitting: boolean;
  // History mode props
  logEntries: GitLogEntry[];
  logLoading: boolean;
  selectedCommitHash: string | null;
  aheadCount: number;
  /** True when the current branch has no upstream (no origin/<branch>). */
  needsPublish?: boolean;
  /** Scope of the commit log: only the current branch, or all refs. */
  logScope: "current" | "all";
  /** Author filter: show all commits, or only those by the current git user. */
  logAuthorFilter: "all" | "mine";
  /** Display name of the current branch (for the toggle label). */
  currentBranch: string;
  /** Files inside the currently-selected untracked directory */
  dirFiles?: string[];
  /** All branches (local + remote) — used by the dashboard sidebar section. */
  branches?: GitBranch[];
}>();

const emit = defineEmits<{
  select: [path: string, staged: boolean];
  changeView: [mode: ViewMode];
  stageFile: [path: string];
  unstageFile: [path: string];
  stageAll: [];
  /** Stage a specific list of file paths (used by section "+" buttons). */
  stagePaths: [paths: string[]];
  unstageAll: [];
  commit: [];
  "update:commitSummary": [value: string];
  "update:commitDescription": [value: string];
  selectCommit: [hash: string];
  editCommit: [entry: GitLogEntry];
  /** Change the log scope toggle (current branch vs all refs). */
  "update:logScope": [scope: "current" | "all"];
  /** Toggle the author filter (all commits vs mine only). */
  "update:logAuthorFilter": [filter: "all" | "mine"];
  /** Select a specific file inside an expanded untracked directory */
  "select-dir-file": [path: string];
  /** Discard changes to a file (tracked: restore, untracked: delete) */
  discard: [path: string, section: string];
  /** Append file path to .gitignore */
  addToGitignore: [path: string];
  /** Request a full repo state refresh (after absorb, etc.) */
  refresh: [];
}>();

const { t, locale } = useI18n();

// ─── Context menu ─────────────────────────────────────────────
interface CtxMenu {
  visible: boolean;
  x: number;
  y: number;
  file: RepoFileEntry | null;
}
const ctxMenu = ref<CtxMenu>({ visible: false, x: 0, y: 0, file: null });

function openContextMenu(e: MouseEvent, file: RepoFileEntry) {
  e.preventDefault();
  e.stopPropagation();
  ctxMenu.value = { visible: true, x: e.clientX, y: e.clientY, file };
}

function closeContextMenu() {
  ctxMenu.value.visible = false;
}

function onCtxDiscard() {
  if (!ctxMenu.value.file) return;
  emit("discard", ctxMenu.value.file.path, ctxMenu.value.file.section);
  closeContextMenu();
}

function onCtxGitignore() {
  if (!ctxMenu.value.file) return;
  emit("addToGitignore", ctxMenu.value.file.path);
  closeContextMenu();
}

// ─── Absorb ────────────────────────────────────────────
const absorbApi = useAbsorb();
const absorbCandidate = ref<AbsorbCandidate | null>(null);
const absorbError = ref<string | null>(null);

async function onCtxAbsorb() {
  const file = ctxMenu.value.file;
  if (!file || !props.cwd) return;
  closeContextMenu();
  absorbCandidate.value = null;
  absorbError.value = null;

  try {
    const staged = file.section === "staged";
    const results = await absorbApi.analyze(props.cwd, [file.path], staged);
    if (results.length === 0) {
      absorbError.value = t("absorb.noCandidate");
      return;
    }
    absorbCandidate.value = results[0];
    // Confirm
    const msg = t("absorb.confirmDesc")
      .replace("{0}", file.path)
      .replace("{1}", results[0].targetShortHash + " " + results[0].targetMessage);
    if (!confirm(msg)) {
      absorbCandidate.value = null;
      return;
    }
    await absorbApi.absorb(props.cwd, results[0]);
    absorbCandidate.value = null;
    // Trigger repo refresh
    emit("refresh");
  } catch (err: unknown) {
    absorbError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  window.addEventListener("click", closeContextMenu);
  window.addEventListener("contextmenu", closeContextMenu);
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") closeContextMenu();
  });
});
onUnmounted(() => {
  window.removeEventListener("click", closeContextMenu);
  window.removeEventListener("contextmenu", closeContextMenu);
});

// ─── AI commit message generation ─────────────────────────
const ai = useAIProvider();
const { isGenerating, lastError: aiError, generate: generateCommitMsg, transform: transformCommitMsg } = useCommitMessage();
const aiMenuOpen = ref(false);
const aiLangMenuOpen = ref(false);

/** Close AI menu when clicking outside */
function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".commit-ai-wrapper")) {
    aiMenuOpen.value = false;
    aiLangMenuOpen.value = false;
  }
}
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

function applyMessage(msg: string) {
  const [summary, ...rest] = msg.split("\n");
  emit("update:commitSummary", summary.trim());
  const body = rest.join("\n").trim();
  emit("update:commitDescription", body);
}

async function onGenerateCommitMessage() {
  if (!props.cwd || isGenerating.value) return;
  aiMenuOpen.value = false;
  const lang = locale.value.startsWith("en") ? "en" : "fr";
  try {
    const msg = await generateCommitMsg(props.cwd, { locale: lang as "fr" | "en" });
    applyMessage(msg);
  } catch {
    // lastError is already set by the composable — the UI shows it.
  }
}

async function onAiAction(action: "regenerate" | "shorten" | "detail" | "changeLang", targetLocale?: string) {
  aiMenuOpen.value = false;
  aiLangMenuOpen.value = false;
  if (isGenerating.value) return;
  if (action === "regenerate") {
    await onGenerateCommitMessage();
    return;
  }
  const currentMsg = [props.commitSummary, props.commitDescription].filter(Boolean).join("\n");
  if (!currentMsg.trim()) return;
  try {
    const msg = await transformCommitMsg(action, currentMsg, targetLocale);
    applyMessage(msg);
  } catch {
    // aiError is set by the composable.
  }
}

const sections = computed(() => {
  const map: Record<string, RepoFileEntry[]> = {
    conflicted: [],
    staged: [],
    unstaged: [],
    untracked: [],
  };
  for (const f of props.files) {
    map[f.section].push(f);
  }
  return map;
});

const sectionMeta = computed((): Record<string, { label: string; color: string; icon: string }> => ({
  conflicted: { label: t('sidebar.sectionConflicts'), color: "var(--color-danger)", icon: "!" },
  staged: { label: t('sidebar.sectionStaged'), color: "var(--color-success)", icon: "+" },
  unstaged: { label: t('sidebar.sectionModified'), color: "var(--color-warning)", icon: "~" },
  untracked: { label: t('sidebar.sectionUntracked'), color: "var(--color-text-muted)", icon: "?" },
}));

function statusBadge(status: string): string {
  const map: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
  return map[status] ?? "?";
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    added: "var(--color-success)",
    modified: "var(--color-warning)",
    deleted: "var(--color-danger)",
    renamed: "var(--color-accent)",
  };
  return map[status] ?? "var(--color-text-muted)";
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function fileDir(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
}

const totalChanges = computed(() => props.files.length);

const unstagedCount = computed(() => props.repoStats.unstaged + props.repoStats.untracked);

function onStageClick(e: Event, path: string) {
  e.stopPropagation();
  emit("stageFile", path);
}

function onUnstageClick(e: Event, path: string) {
  e.stopPropagation();
  emit("unstageFile", path);
}

function onSummaryInput(e: Event) {
  emit("update:commitSummary", (e.target as HTMLInputElement).value);
}

function onDescriptionInput(e: Event) {
  emit("update:commitDescription", (e.target as HTMLTextAreaElement).value);
}

function onCommitKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (props.canCommit) emit("commit");
  }
}

// ─── Dashboard sidebar helpers ────────────────────────────────
/** Local branches sorted with the current branch first, then by activity. */
const pinnedBranches = computed(() => {
  const list = (props.branches ?? []).filter((b) => !b.isRemote);
  return list
    .slice()
    .sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      return (b.ahead + b.behind) - (a.ahead + a.behind);
    })
    .slice(0, 5);
});

/** Up to 3 most recent commits — shown as a mini-activity feed. */
const recentActivity = computed(() => props.logEntries.slice(0, 3));

function activityInitials(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function activityAvatarStyle(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))`,
  };
}

function formatActivityDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t("date.now");
  if (diffMins < 60) return t("date.minutesAgo", diffMins);
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return t("date.hoursAgo", diffHrs);
  const diffDays = Math.floor(diffHrs / 24);
  return t("date.daysAgo", diffDays);
}
</script>

<template>
  <nav class="repo-sidebar" :aria-label="t('sidebar.tabChanges')">
    <!-- View mode tabs -->
    <div class="view-tabs">
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'dashboard' }"
        @click="emit('changeView', 'dashboard')"
        title="Dashboard"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align: -2px;">
          <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
          <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
          <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
          <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
        </svg>
      </button>
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'changes' }"
        @click="emit('changeView', 'changes')"
      >
        {{ t('sidebar.tabChanges') }}
        <span class="tab-badge" v-if="totalChanges > 0">{{ totalChanges }}</span>
      </button>
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'history' }"
        @click="emit('changeView', 'history')"
      >
        {{ t('sidebar.tabLog') }}
      </button>
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'graph' }"
        @click="emit('changeView', 'graph')"
      >
        {{ t('sidebar.tabGraph') }}
      </button>
      <button
        class="view-tab view-tab--pr"
        :class="{ 'view-tab--active': viewMode === 'prs' }"
        @click="emit('changeView', 'prs')"
        title="Pull Requests"
      >
        PRs
      </button>
    </div>

    <!-- File sections -->
    <div class="sections" v-if="viewMode === 'changes'">
      <template v-for="sectionKey in ['conflicted', 'staged', 'unstaged', 'untracked']" :key="sectionKey">
        <div
          v-if="sections[sectionKey].length > 0"
          class="section"
        >
          <div class="section-header">
            <span class="section-icon" :style="{ color: sectionMeta[sectionKey].color }">
              {{ sectionMeta[sectionKey].icon }}
            </span>
            <span class="section-label">{{ sectionMeta[sectionKey].label }}</span>
            <span class="section-count">{{ sections[sectionKey].length }}</span>
            <!-- Stage all / Unstage all buttons -->
            <button
              v-if="sectionKey === 'unstaged' || sectionKey === 'untracked'"
              class="section-action"
              @click="emit('stagePaths', sections[sectionKey].map(f => f.path))"
              :title="t('sidebar.stageAll')"
            >+</button>
            <button
              v-if="sectionKey === 'staged'"
              class="section-action"
              @click="emit('unstageAll')"
              :title="t('sidebar.unstageAll')"
            >-</button>
          </div>

          <ul class="file-items" role="listbox">
            <template
              v-for="file in sections[sectionKey]"
              :key="`${file.section}-${file.path}`"
            >
              <!-- Directory or regular file item -->
              <li
                class="file-item"
                :class="{ 'file-item--selected': selectedFile === file.path }"
                role="option"
                :aria-selected="selectedFile === file.path"
                tabindex="0"
                @click="emit('select', file.path, file.section === 'staged')"
                @keydown.enter="emit('select', file.path, file.section === 'staged')"
                @keydown.space.prevent="emit('select', file.path, file.section === 'staged')"
                @contextmenu.prevent.stop="openContextMenu($event, file)"
              >
                <span
                  class="file-status-badge mono"
                  :style="{ color: statusColor(file.status) }"
                  :title="file.status"
                >
                  {{ statusBadge(file.status) }}
                </span>
                <div class="file-info">
                  <span class="file-name mono">{{ fileName(file.path) }}</span>
                  <span class="file-dir muted" v-if="fileDir(file.path)">{{ fileDir(file.path) }}</span>
                </div>
                <!-- Stage / Unstage per file -->
                <button
                  v-if="file.section === 'unstaged' || file.section === 'untracked'"
                  class="file-action"
                  @click="onStageClick($event, file.path)"
                  :title="t('sidebar.stage')"
                >+</button>
                <button
                  v-if="file.section === 'staged'"
                  class="file-action"
                  @click="onUnstageClick($event, file.path)"
                  :title="t('sidebar.unstage')"
                >-</button>
              </li>

              <!-- Sub-files for expanded untracked directory -->
              <!-- Stay expanded when directory OR one of its sub-files is selected -->
              <li
                v-if="file.path.endsWith('/') && dirFiles?.length && (selectedFile === file.path || dirFiles.includes(selectedFile ?? ''))"
                v-for="subFile in dirFiles"
                :key="`dir-sub-${subFile}`"
                class="file-item file-item--sub"
                :class="{ 'file-item--selected': selectedFile === subFile }"
                role="option"
                tabindex="0"
                @click.stop="emit('select-dir-file', subFile)"
                @keydown.enter.stop="emit('select-dir-file', subFile)"
              >
                <span class="file-status-badge mono" style="color: #16a34a">A</span>
                <div class="file-info">
                  <span class="file-name mono">{{ fileName(subFile) }}</span>
                  <span class="file-dir muted">{{ subFile }}</span>
                </div>
              </li>
            </template>
          </ul>
        </div>
      </template>

      <!-- Empty state -->
      <div class="empty-section" v-if="totalChanges === 0">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 12l2 2 4-4" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="12" cy="12" r="9" stroke="var(--color-success)" stroke-width="1.5" opacity="0.4"/>
        </svg>
        <span class="empty-text">{{ t('sidebar.cleanTree') }}</span>
      </div>

    </div>

    <!-- Commit panel — fixed at bottom, always visible in changes view -->
    <div class="commit-panel" v-if="viewMode === 'changes'">
      <div class="commit-summary-row">
        <input
          class="commit-summary mono"
          type="text"
          :value="commitSummary"
          @input="onSummaryInput"
          @keydown="onCommitKeydown"
          :placeholder="t('sidebar.summaryPlaceholder')"
        />
        <!-- AI commit message: split-button with dropdown -->
        <div v-if="ai.isAvailable.value" class="commit-ai-wrapper">
          <button
            class="commit-ai-btn"
            :class="{ 'commit-ai-btn--loading': isGenerating }"
            :disabled="isGenerating || repoStats.staged === 0"
            :title="isGenerating ? t('sidebar.aiGeneratingTooltip') : t('sidebar.aiGenerateTooltip')"
            @click="onGenerateCommitMessage"
          >
            <svg v-if="isGenerating" class="commit-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
              <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2l1.5 3.5L13 7l-3.5 1.5L8 12l-1.5-3.5L3 7l3.5-1.5L8 2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>
            </svg>
          </button>
          <button
            class="commit-ai-chevron"
            :disabled="isGenerating"
            @click.stop="aiMenuOpen = !aiMenuOpen"
            aria-label="AI actions"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
              <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <ul v-if="aiMenuOpen" class="commit-ai-menu">
            <li @click="onAiAction('regenerate')" :class="{ disabled: repoStats.staged === 0 }">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 8a6 6 0 0110.47-4M14 8a6 6 0 01-10.47 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M12 1v3h-3M4 15v-3h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {{ t('sidebar.aiRegenerate') }}
            </li>
            <li @click="onAiAction('shorten')" :class="{ disabled: !commitSummary }">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 8h6M3 12h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              {{ t('sidebar.aiShorten') }}
            </li>
            <li @click="onAiAction('detail')" :class="{ disabled: !commitSummary }">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              {{ t('sidebar.aiDetail') }}
            </li>
            <li class="commit-ai-menu-parent" :class="{ disabled: !commitSummary }" @click.stop="commitSummary && (aiLangMenuOpen = !aiLangMenuOpen)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 8h11M8 2.5c-1.5 2-1.5 9 0 11M8 2.5c1.5 2 1.5 9 0 11" stroke="currentColor" stroke-width="1.2"/></svg>
              {{ t('sidebar.aiChangeLang') }}
              <svg class="commit-ai-menu-arrow" width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M3 1.5L5.5 4L3 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <ul v-if="aiLangMenuOpen" class="commit-ai-submenu">
                <li v-for="loc in supportedLocales" :key="loc" @click.stop="onAiAction('changeLang', loc)">
                  {{ localeLabels[loc] }}
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </div>
      <!-- AI error feedback -->
      <div v-if="aiError" class="commit-ai-error">{{ aiError }}</div>
      <textarea
        class="commit-description mono"
        :value="commitDescription"
        @input="onDescriptionInput"
        @keydown="onCommitKeydown"
        :placeholder="t('sidebar.descriptionPlaceholder')"
        rows="2"
      ></textarea>
      <div class="commit-actions">
        <button
          class="commit-stage-all"
          v-if="unstagedCount > 0"
          @click="emit('stageAll')"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>{{ t('sidebar.stageAllButton', unstagedCount) }}</span>
        </button>
        <button
          class="commit-btn"
          :class="{ 'commit-btn--disabled': !canCommit }"
          :disabled="!canCommit"
          @click="emit('commit')"
        >
          <svg v-if="isCommitting" class="commit-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13.5 3.5l-7 7L3 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ isCommitting ? t('sidebar.commitButtonLoading') : t('sidebar.commitButton', repoStats.staged) }}</span>
        </button>
      </div>
      <span class="commit-hint muted">{{ t('sidebar.commitHint') }}</span>
    </div>

    <!-- History view: commit log in sidebar -->
    <div class="sidebar-log" v-if="viewMode === 'history'">
      <!-- Scope toggle: current branch vs all refs -->
      <div
        class="log-scope-toggle"
        role="tablist"
        :aria-label="t('sidebar.logScopeLabel')"
      >
        <button
          class="log-scope-btn"
          :class="{ 'log-scope-btn--active': logScope === 'current' }"
          role="tab"
          :aria-selected="logScope === 'current'"
          :title="currentBranch ? t('sidebar.logScopeCurrentTitle', currentBranch) : t('sidebar.logScopeCurrent')"
          @click="emit('update:logScope', 'current')"
        >
          {{ t('sidebar.logScopeCurrent') }}
        </button>
        <button
          class="log-scope-btn"
          :class="{ 'log-scope-btn--active': logScope === 'all' }"
          role="tab"
          :aria-selected="logScope === 'all'"
          :title="t('sidebar.logScopeAllTitle')"
          @click="emit('update:logScope', 'all')"
        >
          {{ t('sidebar.logScopeAll') }}
        </button>
      </div>
      <!-- Author filter: all commits vs mine only -->
      <div class="log-author-filter">
        <button
          class="log-author-btn"
          :class="{ 'log-author-btn--active': logAuthorFilter === 'mine' }"
          :aria-pressed="logAuthorFilter === 'mine'"
          :title="logAuthorFilter === 'mine' ? t('sidebar.logAuthorMineTitle') : t('sidebar.logAuthorAllTitle')"
          @click="emit('update:logAuthorFilter', logAuthorFilter === 'mine' ? 'all' : 'mine')"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0">
            <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
          </svg>
          {{ t('sidebar.logAuthorMine') }}
        </button>
      </div>
      <CommitLog
        :entries="logEntries"
        :loading="logLoading"
        :selected-hash="selectedCommitHash"
        :ahead-count="aheadCount"
        :needs-publish="needsPublish"
        @select-commit="(hash: string) => emit('selectCommit', hash)"
        @edit-commit="(entry) => emit('editCommit', entry)"
      />
    </div>

    <!-- PRs view: compact PR list in sidebar -->
    <div class="sidebar-prs" v-if="viewMode === 'prs'">
      <PrListSidebar />
    </div>

    <!-- Dashboard view: pinned branches, activity, quick actions -->
    <div class="sidebar-dashboard" v-if="viewMode === 'dashboard'">
      <!-- Pinned branches -->
      <div class="side-block">
        <div class="side-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="12" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>
          </svg>
          {{ t('sidebar.pinnedBranches') }}
        </div>
        <div class="branch-list">
          <button
            v-for="b in pinnedBranches"
            :key="b.name"
            class="branch-item"
            :class="{ 'branch-item--current': b.isCurrent }"
            @click="emit('changeView', 'graph')"
            :title="b.name"
          >
            <span class="branch-name mono">{{ b.name }}</span>
            <span class="branch-indicator" v-if="b.ahead > 0 || b.behind > 0">
              <span v-if="b.ahead > 0" class="branch-up">↑{{ b.ahead }}</span>
              <span v-if="b.behind > 0" class="branch-down">↓{{ b.behind }}</span>
            </span>
          </button>
          <div class="side-empty" v-if="pinnedBranches.length === 0">
            {{ t('sidebar.noBranches') }}
          </div>
        </div>
      </div>

      <!-- Recent activity -->
      <div class="side-block" v-if="recentActivity.length > 0">
        <div class="side-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          {{ t('sidebar.recentActivity') }}
        </div>
        <button
          v-for="c in recentActivity"
          :key="c.hashFull"
          class="activity-item"
          @click="emit('changeView', 'history')"
          :title="c.message"
        >
          <span class="activity-dot" :style="activityAvatarStyle(c.email || c.author)">
            {{ activityInitials(c.author) }}
          </span>
          <div class="activity-body">
            <div class="activity-msg">{{ c.message }}</div>
            <div class="activity-time">{{ formatActivityDate(c.date) }}</div>
          </div>
        </button>
      </div>

      <!-- Quick actions -->
      <div class="side-block">
        <div class="side-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          {{ t('sidebar.quickActions') }}
        </div>
        <div class="quick-actions">
          <button class="qa" @click="emit('changeView', 'changes')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            {{ t('sidebar.tabChanges') }}
          </button>
          <button class="qa" @click="emit('changeView', 'history')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>
            </svg>
            {{ t('sidebar.tabLog') }}
          </button>
          <button class="qa" @click="emit('changeView', 'graph')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
              <circle cx="18" cy="12" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
            {{ t('sidebar.tabGraph') }}
          </button>
          <button class="qa" @click="emit('changeView', 'prs')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
              <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
            </svg>
            PRs
          </button>
        </div>
      </div>
    </div>
  </nav>

  <!-- Context menu (Teleport to body to avoid overflow clipping) -->
  <Teleport to="body">
    <div
      v-if="ctxMenu.visible && ctxMenu.file"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <!-- Discard : libellé selon la section -->
      <button
        v-if="ctxMenu.file.section !== 'staged'"
        class="ctx-item ctx-item--danger"
        @click="onCtxDiscard"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <span>{{ ctxMenu.file.section === 'untracked' ? 'Supprimer le fichier' : 'Annuler les modifications' }}</span>
      </button>

      <!-- Separator -->
      <div class="ctx-separator" v-if="ctxMenu.file.section !== 'staged'"></div>

      <!-- Absorb into original commit -->
      <button
        v-if="ctxMenu.file.section === 'unstaged' || ctxMenu.file.section === 'staged'"
        class="ctx-item"
        @click="onCtxAbsorb"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3"/>
          <circle cx="8" cy="12" r="2.5" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8 6.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          <path d="M5.5 8l2.5 2 2.5-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>{{ t('absorb.action') }}</span>
      </button>

      <div class="ctx-separator" v-if="ctxMenu.file.section === 'unstaged' || ctxMenu.file.section === 'staged'"></div>

      <!-- Add to .gitignore -->
      <button class="ctx-item" @click="onCtxGitignore">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity="0.5"/>
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span>Ajouter à .gitignore</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.repo-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.view-tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.view-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-5);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: none;
  border-bottom: 2px solid transparent;
  transition: color var(--transition-base), border-color var(--transition-base);
}

.view-tab:hover {
  color: var(--color-text);
}

.view-tab--active {
  color: var(--color-text);
  border-bottom-color: var(--color-accent);
}

.tab-badge {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  background: var(--color-accent);
  color: var(--color-accent-text);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-variant-numeric: tabular-nums;
}

.sections {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.sidebar-log {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Log scope toggle (current branch vs all refs) */
.log-scope-toggle {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.log-scope-btn {
  flex: 1;
  padding: var(--space-2) var(--space-4);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50%;
}

.log-scope-btn:hover {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--color-text);
}

.log-scope-btn--active {
  background: var(--color-accent, #3b82f6);
  color: var(--color-accent-text, #ffffff);
  border-color: var(--color-accent, #3b82f6);
}

.log-scope-btn--active:hover {
  background: var(--color-accent, #3b82f6);
  color: var(--color-accent-text, #ffffff);
}

/* Author filter row */
.log-author-filter {
  display: flex;
  padding: var(--space-2) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.log-author-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
  white-space: nowrap;
}

.log-author-btn:hover {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--color-text);
}

.log-author-btn--active {
  background: var(--color-accent, #3b82f6);
  color: var(--color-accent-text, #ffffff);
  border-color: var(--color-accent, #3b82f6);
}

.log-author-btn--active:hover {
  background: var(--color-accent, #3b82f6);
  color: var(--color-accent-text, #ffffff);
}

.sidebar-prs {
  flex: 1;
  overflow: hidden;
}

.section {
  border-bottom: 1px solid var(--color-border);
}

.section:last-child {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  background: var(--color-bg);
  position: sticky;
  top: 0;
  z-index: 1;
}

.section-icon {
  font-family: var(--font-mono);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-bold);
  width: 16px;
  text-align: center;
}

.section-label {
  flex: 1;
}

.section-count {
  font-variant-numeric: tabular-nums;
  background: var(--color-bg-tertiary);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
}

.section-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--color-text-muted);
  background: none;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.section-action:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.file-items {
  list-style: none;
}

.file-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6) var(--space-3) 18px;
  cursor: pointer;
  transition: background var(--transition-fast);
  border-left: 3px solid transparent;
}

.file-item:hover {
  background: var(--color-bg-tertiary);
}

.file-item--selected {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

/* Sub-files inside an expanded untracked directory */
.file-item--sub {
  padding-left: 30px;
  background: var(--color-bg);
  border-left-color: transparent;
  border-left-width: 1px;
  position: relative;
}

.file-item--sub::before {
  content: '';
  position: absolute;
  left: 17px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
}

.file-item--sub:first-of-type::before {
  top: 50%;
}

.file-item--sub:hover {
  background: var(--color-bg-tertiary);
}

.file-item--sub.file-item--selected {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

.file-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.file-status-badge {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-bold);
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.file-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-dir {
  font-size: var(--font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  flex-shrink: 0;
}

.file-item:hover .file-action {
  opacity: 1;
}

.file-action:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.empty-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-5);
  padding: var(--space-10) var(--space-7);
}

.empty-text {
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
}

/* Commit panel — fixed at bottom of sidebar */
.commit-panel {
  border-top: 1px solid var(--color-border);
  padding: var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.commit-summary-row {
  display: flex;
  gap: var(--space-2);
  align-items: stretch;
}

.commit-summary {
  flex: 1;
  min-width: 0;
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-base);
}

.commit-ai-wrapper {
  position: relative;
  display: flex;
  flex-shrink: 0;
}

.commit-ai-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  background: var(--color-bg-tertiary);
  color: var(--color-accent);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-base), border-color var(--transition-base), color var(--transition-base);
}

.commit-ai-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  background: var(--color-bg-tertiary);
  color: var(--color-accent);
  border: 1px solid var(--color-border);
  margin-left: -1px;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  cursor: pointer;
  transition: background var(--transition-base), border-color var(--transition-base);
}

.commit-ai-chevron:hover:not(:disabled) {
  background: var(--color-bg);
  border-color: var(--color-accent);
  z-index: 1;
}

.commit-ai-chevron:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.commit-ai-btn:hover:not(:disabled) {
  background: var(--color-bg);
  border-color: var(--color-accent);
  z-index: 1;
}

.commit-ai-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.commit-ai-btn--loading {
  color: var(--color-warning);
}

.commit-ai-menu {
  position: absolute;
  right: 0;
  bottom: 100%;
  margin-bottom: 4px;
  min-width: 180px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  list-style: none;
  padding: 4px 0;
}

.commit-ai-menu li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--transition-base);
}

.commit-ai-menu li:hover:not(.disabled) {
  background: var(--color-bg-tertiary);
}

.commit-ai-menu li.disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

.commit-ai-menu-parent {
  position: relative;
}

.commit-ai-menu-arrow {
  margin-left: auto;
  opacity: 0.5;
}

.commit-ai-submenu {
  position: absolute;
  right: 100%;
  bottom: 0;
  margin-right: 2px;
  min-width: 130px;
  max-height: 300px;
  overflow-y: auto;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  list-style: none;
  padding: 4px 0;
  z-index: 101;
}

.commit-ai-submenu li {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--transition-base);
}

.commit-ai-submenu li:hover {
  background: var(--color-bg-tertiary);
}

.commit-ai-error {
  font-size: var(--font-size-xs);
  color: var(--color-danger);
  padding: 0 var(--space-2);
  line-height: 1.4;
}

.commit-summary:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.commit-summary::placeholder {
  color: var(--color-text-muted);
}

.commit-description {
  width: 100%;
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  resize: vertical;
  min-height: 38px;
  max-height: 120px;
  outline: none;
  transition: border-color var(--transition-base);
}

.commit-description:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.commit-description::placeholder {
  color: var(--color-text-muted);
  font-style: italic;
}

.commit-actions {
  display: flex;
  gap: var(--space-3);
}

.commit-stage-all {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: background var(--transition-base), border-color var(--transition-base);
  white-space: nowrap;
}

.commit-stage-all:hover {
  background: var(--color-bg);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.commit-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-6);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-radius: var(--radius-pill);
  transition: background var(--transition-base), opacity var(--transition-base);
}

.commit-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.commit-btn--disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.commit-spinner {
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.commit-hint {
  font-size: var(--font-size-xs);
  text-align: center;
}

/* ─── Dashboard sidebar ──────────────────────────────── */
.sidebar-dashboard {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.side-block { display: flex; flex-direction: column; gap: var(--space-2); }

.side-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-subtle);
}

.branch-list { display: flex; flex-direction: column; gap: 2px; }

.branch-item {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: none;
  border: none;
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
  font-size: var(--font-size-sm);
  transition: background var(--transition-fast);
}

.branch-item:hover { background: var(--color-bg-tertiary); }

.branch-item--current {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.branch-item--current .branch-name { font-weight: 600; }

.branch-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--font-size-sm);
}

.branch-indicator {
  display: inline-flex;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}

.branch-up { color: var(--color-success); }
.branch-down { color: var(--color-info); }

.side-empty {
  padding: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  text-align: center;
}

.activity-item {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background var(--transition-fast);
}

.activity-item:hover { background: var(--color-bg-tertiary); }

.activity-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 600;
  color: white;
  flex-shrink: 0;
}

.activity-body { min-width: 0; }

.activity-msg {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
}

.activity-time {
  font-size: 11px;
  color: var(--color-text-subtle);
  margin-top: 2px;
}

.quick-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  padding: 0 var(--space-3);
}

.qa {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  font-size: var(--font-size-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast);
}

.qa:hover {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}
</style>

<style>
/* Context menu — non-scoped pour Teleport */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 200px;
  background: var(--color-bg-secondary, #1e1e2e);
  border: 1px solid var(--color-border, #313244);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  animation: ctx-fade-in var(--transition-fast) ease;
}

@keyframes ctx-fade-in {
  from { opacity: 0; transform: scale(0.95) translateY(-4px); }
  to   { opacity: 1; transform: scale(1)   translateY(0); }
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text, #cdd6f4);
  background: none;
  border-radius: var(--radius-sm);
  width: 100%;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.ctx-item:hover {
  background: var(--color-bg-tertiary, #313244);
}

.ctx-item--danger {
  color: var(--color-danger, #f38ba8);
}

.ctx-item--danger:hover {
  background: rgba(243, 139, 168, 0.12);
}

.ctx-separator {
  height: 1px;
  background: var(--color-border, #313244);
  margin: var(--space-xs) var(--space-3);
}
</style>

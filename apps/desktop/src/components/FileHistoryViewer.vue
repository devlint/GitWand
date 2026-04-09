<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { BlameLine, FileLogEntry, GitDiff } from "../utils/backend";
import { getGitBlame, getGitFileLog, getGitFileDiff } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { detectLanguage, highlightLine } from "../utils/highlight";
import { wordDiff, segmentsToHtml } from "../utils/wordDiff";

const { t } = useI18n();

const props = defineProps<{
  filePath: string;
  cwd: string;
}>();

const emit = defineEmits<{
  close: [];
  "select-commit": [hash: string];
}>();

// ─── State ──────────────────────────────────────────────
type Tab = "blame" | "log" | "compare";
const activeTab = ref<Tab>("blame");

const blameLines = ref<BlameLine[]>([]);
const fileLog = ref<FileLogEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// ─── Load data on filePath change ───────────────────────
watch(
  () => props.filePath,
  async (path) => {
    if (!path || !props.cwd) return;
    loading.value = true;
    error.value = null;
    try {
      const [blame, log] = await Promise.all([
        getGitBlame(props.cwd, path),
        getGitFileLog(props.cwd, path),
      ]);
      blameLines.value = blame;
      fileLog.value = log;
    } catch (err: any) {
      error.value = err?.message || String(err);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

// ─── Helpers ────────────────────────────────────────────
function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

const language = computed(() => detectLanguage(props.filePath));

function hl(content: string): string {
  return highlightLine(content, language.value);
}

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function formatDate(raw: string): string {
  try {
    const d = new Date(raw);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 30) return `${diffD}d`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return raw;
  }
}

function formatDateFromTimestamp(ts: string): string {
  try {
    const d = new Date(parseInt(ts, 10) * 1000);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return ts;
  }
}

// ─── Blame grouping: detect new author blocks ───────────
function isNewAuthorBlock(idx: number): boolean {
  if (idx === 0) return true;
  const prev = blameLines.value[idx - 1];
  const curr = blameLines.value[idx];
  return prev.hashFull !== curr.hashFull;
}

// ─── Time-travel diff ─────────────────────────────────
const compareFrom = ref<string | null>(null);
const compareTo = ref<string | null>(null);
const compareDiff = ref<GitDiff | null>(null);
const compareLoading = ref(false);

function selectForCompare(hash: string) {
  if (!compareFrom.value) {
    compareFrom.value = hash;
  } else if (!compareTo.value) {
    compareTo.value = hash;
    loadCompare();
  } else {
    // Reset and start over
    compareFrom.value = hash;
    compareTo.value = null;
    compareDiff.value = null;
  }
}

function clearCompare() {
  compareFrom.value = null;
  compareTo.value = null;
  compareDiff.value = null;
}

async function loadCompare() {
  if (!compareFrom.value || !compareTo.value || !props.cwd) return;
  compareLoading.value = true;
  try {
    compareDiff.value = await getGitFileDiff(
      props.cwd,
      props.filePath,
      compareFrom.value,
      compareTo.value,
    );
    activeTab.value = "compare";
  } catch (err: any) {
    error.value = err?.message || String(err);
  } finally {
    compareLoading.value = false;
  }
}

function isSelectedForCompare(hash: string): "from" | "to" | null {
  if (compareFrom.value === hash) return "from";
  if (compareTo.value === hash) return "to";
  return null;
}

/** Compute word-diff pairs for the compare diff */
interface ComparePair {
  left: { type: string; content: string; lineNo?: number } | null;
  right: { type: string; content: string; lineNo?: number } | null;
  leftHtml?: string;
  rightHtml?: string;
}

function buildComparePairs(diff: GitDiff): ComparePair[][] {
  return diff.hunks.map((hunk) => {
    const pairs: ComparePair[] = [];
    let i = 0;
    const lines = hunk.lines;
    while (i < lines.length) {
      if (lines[i].type === "context") {
        pairs.push({
          left: { type: "context", content: lines[i].content, lineNo: lines[i].oldLineNo ?? undefined },
          right: { type: "context", content: lines[i].content, lineNo: lines[i].newLineNo ?? undefined },
        });
        i++;
      } else {
        const dels: typeof lines = [];
        const adds: typeof lines = [];
        while (i < lines.length && lines[i].type === "delete") { dels.push(lines[i]); i++; }
        while (i < lines.length && lines[i].type === "add") { adds.push(lines[i]); i++; }
        const max = Math.max(dels.length, adds.length);
        for (let j = 0; j < max; j++) {
          const d = j < dels.length ? dels[j] : null;
          const a = j < adds.length ? adds[j] : null;
          const pair: ComparePair = {
            left: d ? { type: "delete", content: d.content, lineNo: d.oldLineNo ?? undefined } : null,
            right: a ? { type: "add", content: a.content, lineNo: a.newLineNo ?? undefined } : null,
          };
          if (d && a) {
            const wd = wordDiff(d.content, a.content);
            pair.leftHtml = segmentsToHtml(wd.oldSegments);
            pair.rightHtml = segmentsToHtml(wd.newSegments);
          }
          pairs.push(pair);
        }
      }
    }
    return pairs;
  });
}

const comparePairs = computed(() => {
  if (!compareDiff.value) return [];
  return buildComparePairs(compareDiff.value);
});

function shortHash(hash: string): string {
  return hash.substring(0, 7);
}
</script>

<template>
  <div class="fhv">
    <!-- Header -->
    <div class="fhv-header">
      <div class="fhv-file-info">
        <span class="fhv-file-name mono">{{ fileName(filePath) }}</span>
        <span class="fhv-file-path muted">{{ filePath }}</span>
      </div>
      <div class="fhv-tabs">
        <button
          class="fhv-tab"
          :class="{ 'fhv-tab--active': activeTab === 'blame' }"
          @click="activeTab = 'blame'"
        >Blame</button>
        <button
          class="fhv-tab"
          :class="{ 'fhv-tab--active': activeTab === 'log' }"
          @click="activeTab = 'log'"
        >{{ t('log.title') }}</button>
        <button
          class="fhv-tab"
          :class="{ 'fhv-tab--active': activeTab === 'compare' }"
          @click="activeTab = 'compare'"
        >{{ t('diff.compare') }}</button>
      </div>
      <button class="fhv-close" @click="emit('close')" :title="t('common.close')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path d="M3.646 3.646a.5.5 0 01.708 0L7 6.293l2.646-2.647a.5.5 0 01.708.708L7.707 7l2.647 2.646a.5.5 0 01-.708.708L7 7.707l-2.646 2.647a.5.5 0 01-.708-.708L6.293 7 3.646 4.354a.5.5 0 010-.708z"/>
        </svg>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="fhv-loading">
      <span class="muted">{{ t('common.loading') }}</span>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="fhv-error">
      <span>{{ error }}</span>
    </div>

    <!-- Blame tab -->
    <div v-else-if="activeTab === 'blame'" class="fhv-blame">
      <table class="fhv-blame-table">
        <tbody>
          <tr
            v-for="(line, idx) in blameLines"
            :key="idx"
            class="fhv-blame-line"
            :class="{ 'fhv-blame-line--new-block': isNewAuthorBlock(idx) }"
          >
            <td class="fhv-blame-meta" v-if="isNewAuthorBlock(idx)" :rowspan="1">
              <span
                class="fhv-blame-hash mono"
                :title="line.summary"
                @click="emit('select-commit', line.hashFull)"
              >{{ line.hash }}</span>
              <span class="fhv-blame-author">{{ line.author }}</span>
              <span class="fhv-blame-date muted">{{ formatDateFromTimestamp(line.authorDate) }}</span>
            </td>
            <td class="fhv-blame-meta fhv-blame-meta--empty" v-else></td>
            <td class="fhv-blame-lineno mono">{{ line.finalLine }}</td>
            <td class="fhv-blame-content mono">
              <span v-html="hl(line.content) || '\u00a0'"></span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Log tab -->
    <div v-else-if="activeTab === 'log'" class="fhv-log">
      <!-- Compare selection hint -->
      <div class="fhv-compare-hint" v-if="!compareFrom">
        <span class="muted">{{ t('diff.compareHint') }}</span>
      </div>
      <div class="fhv-compare-hint fhv-compare-hint--active" v-else-if="compareFrom && !compareTo">
        <span>{{ t('diff.compareFrom', shortHash(compareFrom)) }}</span>
        <button class="fhv-compare-clear" @click="clearCompare">{{ t('common.cancel') }}</button>
      </div>

      <div
        v-for="entry in fileLog"
        :key="entry.hashFull"
        class="fhv-log-entry"
        :class="{
          'fhv-log-entry--from': isSelectedForCompare(entry.hashFull) === 'from',
          'fhv-log-entry--to': isSelectedForCompare(entry.hashFull) === 'to',
        }"
      >
        <div class="fhv-log-top">
          <span class="fhv-log-avatar" :style="{ background: avatarColor(entry.author) }">
            {{ entry.author.charAt(0).toUpperCase() }}
          </span>
          <div class="fhv-log-info" @click="emit('select-commit', entry.hashFull)">
            <div class="fhv-log-message">{{ entry.message }}</div>
            <div class="fhv-log-meta muted">
              <span>{{ entry.author }}</span>
              <span class="fhv-log-sep">&middot;</span>
              <span>{{ formatDate(entry.date) }}</span>
              <span class="fhv-log-sep">&middot;</span>
              <span class="mono fhv-log-hash">{{ entry.hash }}</span>
            </div>
          </div>
          <button
            class="fhv-compare-btn"
            @click.stop="selectForCompare(entry.hashFull)"
            :title="t('diff.compareSelect')"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 7h8M7 3v8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" v-if="!isSelectedForCompare(entry.hashFull)"/>
              <circle cx="7" cy="7" r="3" fill="currentColor" v-else/>
            </svg>
          </button>
        </div>
      </div>
      <div v-if="fileLog.length === 0" class="fhv-log-empty muted">
        {{ t('log.noCommit') }}
      </div>
    </div>

    <!-- Compare tab (time-travel diff) -->
    <div v-else-if="activeTab === 'compare'" class="fhv-compare">
      <div v-if="compareLoading" class="fhv-loading">
        <span class="muted">{{ t('common.loading') }}</span>
      </div>
      <div v-else-if="!compareDiff || !compareFrom || !compareTo" class="fhv-compare-empty">
        <span class="muted">{{ t('diff.compareEmpty') }}</span>
        <button class="fhv-compare-go-log" @click="activeTab = 'log'">{{ t('diff.compareGoLog') }}</button>
      </div>
      <div v-else class="fhv-compare-result">
        <div class="fhv-compare-header mono">
          <span class="fhv-compare-label fhv-compare-label--from">{{ shortHash(compareFrom) }}</span>
          <span class="muted">&rarr;</span>
          <span class="fhv-compare-label fhv-compare-label--to">{{ shortHash(compareTo) }}</span>
        </div>
        <div class="fhv-compare-diff" v-if="compareDiff.hunks.length > 0">
          <div v-for="(hunkPairs, hIdx) in comparePairs" :key="hIdx" class="fhv-compare-hunk">
            <div class="hunk-header mono">{{ compareDiff.hunks[hIdx].header }}</div>
            <table class="diff-table diff-table--sbs">
              <tbody>
                <tr v-for="(pair, pIdx) in hunkPairs" :key="pIdx" class="diff-line">
                  <td class="line-no mono" :class="pair.left ? `sbs-cell--${pair.left.type}` : 'sbs-cell--empty'">
                    {{ pair.left?.lineNo ?? '' }}
                  </td>
                  <td class="line-content mono sbs-content" :class="pair.left ? `sbs-cell--${pair.left.type}` : 'sbs-cell--empty'">
                    <span v-html="pair.leftHtml ?? (pair.left ? (hl(pair.left.content) || '\u00a0') : '\u00a0')"></span>
                  </td>
                  <td class="sbs-gutter"></td>
                  <td class="line-no mono" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                    {{ pair.right?.lineNo ?? '' }}
                  </td>
                  <td class="line-content mono sbs-content" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                    <span v-html="pair.rightHtml ?? (pair.right ? (hl(pair.right.content) || '\u00a0') : '\u00a0')"></span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="fhv-compare-empty">
          <span class="muted">{{ t('diff.noDiff') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fhv {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.fhv-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fhv-file-info {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.fhv-file-name {
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.fhv-file-path {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fhv-tabs {
  display: flex;
  gap: 2px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  padding: 2px;
  flex-shrink: 0;
}

.fhv-tab {
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.fhv-tab:hover {
  color: var(--color-text);
}

.fhv-tab--active {
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.fhv-close {
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: 4px;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.fhv-close:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fhv-loading,
.fhv-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  font-size: 13px;
}

.fhv-error {
  color: var(--color-danger);
}

/* ─── Blame ──────────────────────────────────────────── */
.fhv-blame {
  flex: 1;
  overflow: auto;
}

.fhv-blame-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.fhv-blame-line {
  line-height: 1.5;
}

.fhv-blame-line--new-block {
  border-top: 1px solid var(--color-border);
}

.fhv-blame-meta {
  width: 200px;
  min-width: 200px;
  padding: 2px 8px;
  font-size: 11px;
  vertical-align: top;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fhv-blame-meta--empty {
  background: var(--color-bg-secondary);
}

.fhv-blame-hash {
  font-size: 10px;
  color: var(--color-accent);
  cursor: pointer;
  margin-right: 6px;
}

.fhv-blame-hash:hover {
  text-decoration: underline;
}

.fhv-blame-author {
  color: var(--color-text);
  font-weight: 500;
  margin-right: 6px;
}

.fhv-blame-date {
  font-size: 10px;
}

.fhv-blame-lineno {
  width: 44px;
  min-width: 44px;
  padding: 0 6px;
  text-align: right;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--color-border);
}

.fhv-blame-content {
  padding: 0 10px;
  font-size: 12px;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── Log ────────────────────────────────────────────── */
.fhv-log {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
}

.fhv-log-entry {
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.12s;
  border-bottom: 1px solid var(--color-border);
}

.fhv-log-entry:hover {
  background: var(--color-bg-tertiary);
}

.fhv-log-top {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.fhv-log-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.fhv-log-info {
  flex: 1;
  min-width: 0;
}

.fhv-log-message {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.3;
}

.fhv-log-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  margin-top: 3px;
}

.fhv-log-sep {
  opacity: 0.4;
}

.fhv-log-hash {
  font-size: 10px;
  color: var(--color-accent);
}

.fhv-log-empty {
  padding: 40px;
  text-align: center;
  font-size: 13px;
}

/* ─── Compare hint ──────────────────────────────────── */
.fhv-compare-hint {
  padding: 8px 16px;
  font-size: 12px;
  border-bottom: 1px solid var(--color-border);
}

.fhv-compare-hint--active {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--color-accent-bg, rgba(56, 132, 255, 0.08));
  color: var(--color-accent);
}

.fhv-compare-clear {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: pointer;
}

.fhv-compare-clear:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fhv-compare-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}

.fhv-compare-btn:hover {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-bg, rgba(56, 132, 255, 0.08));
}

/* Selected log entries */
.fhv-log-entry--from {
  background: rgba(56, 132, 255, 0.08);
  border-left: 3px solid var(--color-accent);
}

.fhv-log-entry--to {
  background: rgba(80, 200, 120, 0.08);
  border-left: 3px solid var(--color-success, #50c878);
}

/* ─── Compare tab ───────────────────────────────────── */
.fhv-compare {
  flex: 1;
  overflow: auto;
}

.fhv-compare-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  font-size: 13px;
}

.fhv-compare-go-log {
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  cursor: pointer;
  transition: background 0.12s;
}

.fhv-compare-go-log:hover {
  background: var(--color-bg-tertiary);
}

.fhv-compare-result {
  display: flex;
  flex-direction: column;
}

.fhv-compare-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.fhv-compare-label--from {
  color: var(--color-accent);
  font-weight: 600;
}

.fhv-compare-label--to {
  color: var(--color-success, #50c878);
  font-weight: 600;
}

.fhv-compare-diff {
  flex: 1;
}

.fhv-compare-hunk {
  border-bottom: 1px solid var(--color-border);
}

/* ─── Diff table styles (replicated from DiffViewer) ── */
.hunk-header {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.diff-table--sbs .line-no {
  width: 44px;
  min-width: 44px;
}

.diff-line {
  line-height: 1.5;
}

.line-no {
  width: 44px;
  min-width: 44px;
  padding: 0 6px;
  text-align: right;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--color-border);
}

.line-content {
  padding: 0 10px;
  font-size: var(--code-font-size, 12px);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sbs-gutter {
  width: 1px;
  min-width: 1px;
  background: var(--color-border);
}

.sbs-content {
  width: 50%;
}

.sbs-cell--context {
  background: transparent;
}

.sbs-cell--delete {
  background: var(--color-diff-del-bg, rgba(255, 0, 0, 0.06));
}

.sbs-cell--add {
  background: var(--color-diff-add-bg, rgba(0, 180, 0, 0.06));
}

.sbs-cell--empty {
  background: var(--color-bg-tertiary);
}
</style>

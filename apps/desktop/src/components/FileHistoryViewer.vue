<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { BlameLine, FileLogEntry, GitDiff } from "../utils/backend";
import Avatar from "./Avatar.vue";
import { getGitBlame, getGitFileLog, getGitFileLogPickaxe, getGitFileLogRange, getGitFileDiff, type BlameAlgorithm, type PickaxeMode } from "../utils/backend";
import { loadSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import { detectLanguage, highlightLine } from "../utils/highlight";
import { safeHtml } from "../composables/useSafeHtml";
import { wordDiff, segmentsToHtml } from "../utils/wordDiff";
import { useAIProvider } from "../composables/useAIProvider";
import { useBlameContext } from "../composables/useBlameContext";
import AiSparkle from "./AiSparkle.vue";

const { t, locale } = useI18n();
const ai = useAIProvider();
const { isGenerating: isExplainingBlame, explain: explainBlame } = useBlameContext();

// ─── Blame context explanation (Phase 1.3.4) ─────────────
const blameExplainHash = ref<string | null>(null);
const blameExplainText = ref<string | null>(null);
const blameExplainError = ref<string | null>(null);

async function requestBlameExplain(hashFull: string) {
  // Toggle off when clicking the same commit again.
  if (blameExplainHash.value === hashFull) {
    closeBlameExplain();
    return;
  }
  blameExplainHash.value = hashFull;
  blameExplainText.value = null;
  blameExplainError.value = null;
  try {
    const text = await explainBlame(props.cwd, hashFull, props.filePath, {
      locale: locale.value,
    });
    // Guard against the user switching commits mid-flight.
    if (blameExplainHash.value === hashFull) {
      blameExplainText.value = text;
    }
  } catch (err: any) {
    if (blameExplainHash.value === hashFull) {
      blameExplainError.value = err?.message ?? String(err);
    }
  }
}

function closeBlameExplain() {
  blameExplainHash.value = null;
  blameExplainText.value = null;
  blameExplainError.value = null;
}

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

/** Blame algorithm — initialised from settings, overridable inline without leaving the view. */
const blameAlgo = ref<BlameAlgorithm>(loadSettings().blameAlgorithm ?? "histogram");

// ─── Pickaxe (Log tab search) ────────────────────────────
const pickaxeQuery = ref("");
const pickaxeMode = ref<PickaxeMode>("S");
const pickaxeResults = ref<FileLogEntry[] | null>(null);
const pickaxeLoading = ref(false);
const pickaxeError = ref<string | null>(null);

async function runPickaxe() {
  const q = pickaxeQuery.value.trim();
  if (!q || !props.cwd || !props.filePath) return;
  pickaxeLoading.value = true;
  pickaxeError.value = null;
  try {
    pickaxeResults.value = await getGitFileLogPickaxe(props.cwd, props.filePath, q, pickaxeMode.value);
  } catch (err: any) {
    pickaxeError.value = err?.message || String(err);
  } finally {
    pickaxeLoading.value = false;
  }
}

function clearPickaxe() {
  pickaxeQuery.value = "";
  pickaxeResults.value = null;
  pickaxeError.value = null;
}

// ─── Line-range (Blame tab → switch to Log) ──────────────
const rangeLogLines = ref<{ start: number; end: number } | null>(null);
const rangeLogResults = ref<FileLogEntry[] | null>(null);
const rangeLogLoading = ref(false);
const rangeLogError = ref<string | null>(null);

async function showRangeHistory(startLine: number, endLine: number) {
  if (!props.cwd || !props.filePath) return;
  rangeLogLines.value = { start: startLine, end: endLine };
  rangeLogResults.value = null;
  rangeLogError.value = null;
  activeTab.value = "log";   // switch to log tab to show results
  rangeLogLoading.value = true;
  try {
    rangeLogResults.value = await getGitFileLogRange(props.cwd, props.filePath, startLine, endLine);
  } catch (err: any) {
    rangeLogError.value = err?.message || String(err);
  } finally {
    rangeLogLoading.value = false;
  }
}

function clearRangeLog() {
  rangeLogLines.value = null;
  rangeLogResults.value = null;
}

// The effective log to display in the Log tab:
// 1. range log (from blame line selection) takes priority
// 2. pickaxe results if a search is active
// 3. full file log otherwise
const displayedLog = computed<FileLogEntry[]>(() => {
  if (rangeLogResults.value !== null) return rangeLogResults.value;
  if (pickaxeResults.value !== null) return pickaxeResults.value;
  return fileLog.value;
});

/** Show line-range history for the consecutive block of blame lines starting at idx. */
function showRangeHistoryForBlock(idx: number) {
  const targetHash = blameLines.value[idx]?.hashFull;
  if (!targetHash) return;
  // Find where this hash block starts and ends
  let start = idx;
  while (start > 0 && blameLines.value[start - 1]?.hashFull === targetHash) start--;
  let end = idx;
  while (end < blameLines.value.length - 1 && blameLines.value[end + 1]?.hashFull === targetHash) end++;
  const startLine = blameLines.value[start].finalLine;
  const endLine = blameLines.value[end].finalLine;
  showRangeHistory(startLine, endLine);
}

async function loadBlame(path: string) {
  if (!path || !props.cwd) return;
  loading.value = true;
  error.value = null;
  try {
    blameLines.value = await getGitBlame(props.cwd, path, blameAlgo.value);
  } catch (err: any) {
    error.value = err?.message || String(err);
  } finally {
    loading.value = false;
  }
}

// Reload blame when algorithm changes (file stays the same)
watch(blameAlgo, () => { if (props.filePath) loadBlame(props.filePath); });

// ─── Load data on filePath change ───────────────────────
watch(
  () => props.filePath,
  async (path) => {
    if (!path || !props.cwd) return;
    loading.value = true;
    error.value = null;
    try {
      const [blame, log] = await Promise.all([
        getGitBlame(props.cwd, path, blameAlgo.value),
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
      <!-- Blame algo selector — only shown on the blame tab -->
      <select
        v-if="activeTab === 'blame'"
        :value="blameAlgo"
        class="fhv-algo-select"
        :title="t('settings.blameAlgorithm')"
        @change="blameAlgo = ($event.target as HTMLSelectElement).value as BlameAlgorithm"
      >
        <option value="histogram">histogram</option>
        <option value="patience">patience</option>
        <option value="minimal">minimal</option>
        <option value="myers">myers</option>
      </select>
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
              <button
                v-if="ai.isAvailable.value"
                class="btn btn--ai btn--icon fhv-blame-explain"
                :class="{ 'fhv-blame-explain--active': blameExplainHash === line.hashFull }"
                :title="t('fileHistory.explainChange')"
                :aria-label="t('fileHistory.explainChange')"
                @click.stop="requestBlameExplain(line.hashFull)"
              ><AiSparkle :size="14" /></button>
              <!-- Line-range history button — shows history for the block of consecutive lines with this hash -->
              <button
                class="fhv-blame-range-btn"
                :title="t('fhv.showLineHistory')"
                @click.stop="showRangeHistoryForBlock(idx)"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/>
                  <path d="M8 5v3l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <span class="fhv-blame-author">{{ line.author }}</span>
              <span class="fhv-blame-date muted">{{ formatDateFromTimestamp(line.authorDate) }}</span>
            </td>
            <td class="fhv-blame-meta fhv-blame-meta--empty" v-else></td>
            <td class="fhv-blame-lineno mono">{{ line.finalLine }}</td>
            <td class="fhv-blame-content mono">
              <span v-html="safeHtml(hl(line.content)) || '\u00a0'"></span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Blame context explanation panel (Phase 1.3.4) -->
      <div v-if="blameExplainHash" class="fhv-blame-explain-panel" role="status" aria-live="polite">
        <div class="fhv-blame-explain-head">
          <span class="fhv-blame-explain-title">
            <AiSparkle :size="13" />
            {{ t('fileHistory.whyThisChange') }}
          </span>
          <button class="fhv-blame-explain-close" @click="closeBlameExplain" aria-label="Close">✕</button>
        </div>
        <div class="fhv-blame-explain-body">
          <span v-if="blameExplainError" class="fhv-blame-explain-error">{{ blameExplainError }}</span>
          <span v-else-if="isExplainingBlame && !blameExplainText">
            {{ t('fileHistory.analyzingCommit') }}
          </span>
          <span v-else>{{ blameExplainText }}</span>
        </div>
      </div>
    </div>

    <!-- Log tab -->
    <div v-else-if="activeTab === 'log'" class="fhv-log">
      <!-- Pickaxe search bar -->
      <div class="fhv-pickaxe-bar">
        <div class="fhv-pickaxe-modes">
          <button class="fhv-pickaxe-mode" :class="{ 'fhv-pickaxe-mode--active': pickaxeMode === 'S' }" @click="pickaxeMode = 'S'" title="-S: literal string">S</button>
          <button class="fhv-pickaxe-mode" :class="{ 'fhv-pickaxe-mode--active': pickaxeMode === 'G' }" @click="pickaxeMode = 'G'" title="-G: regex">G</button>
        </div>
        <input
          v-model="pickaxeQuery"
          class="fhv-pickaxe-input"
          :placeholder="t('fhv.pickaxePlaceholder')"
          @keydown.enter="runPickaxe"
          @keydown.esc="clearPickaxe"
        />
        <button v-if="pickaxeQuery" class="fhv-pickaxe-clear" @click="clearPickaxe" :title="t('common.close')">✕</button>
      </div>
      <!-- Range log banner -->
      <div v-if="rangeLogLines" class="fhv-range-banner">
        <span>{{ t('fhv.rangeHistory', rangeLogLines.start, rangeLogLines.end) }}</span>
        <button class="fhv-pickaxe-clear" @click="clearRangeLog">✕</button>
      </div>
      <p v-if="pickaxeError || rangeLogError" class="fhv-pickaxe-error">{{ pickaxeError ?? rangeLogError }}</p>
      <div v-if="pickaxeLoading || rangeLogLoading" class="fhv-loading"><span class="muted">{{ t('common.loading') }}</span></div>
      <p v-else-if="pickaxeResults !== null && displayedLog.length === 0" class="fhv-pickaxe-empty muted">{{ t('fhv.pickaxeNoResults') }}</p>

      <!-- Compare selection hint -->
      <div class="fhv-compare-hint" v-if="!compareFrom">
        <span class="muted">{{ t('diff.compareHint') }}</span>
      </div>
      <div class="fhv-compare-hint fhv-compare-hint--active" v-else-if="compareFrom && !compareTo">
        <span>{{ t('diff.compareFrom', shortHash(compareFrom)) }}</span>
        <button class="fhv-compare-clear" @click="clearCompare">{{ t('common.cancel') }}</button>
      </div>

      <div
        v-for="entry in displayedLog"
        :key="entry.hashFull"
        class="fhv-log-entry"
        :class="{
          'fhv-log-entry--from': isSelectedForCompare(entry.hashFull) === 'from',
          'fhv-log-entry--to': isSelectedForCompare(entry.hashFull) === 'to',
        }"
      >
        <div class="fhv-log-top">
          <Avatar class="fhv-log-avatar" :name="entry.author" />
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
                    <span v-html="safeHtml(pair.leftHtml ?? (pair.left ? hl(pair.left.content) : '')) || '\u00a0'"></span>
                  </td>
                  <td class="sbs-gutter"></td>
                  <td class="line-no mono" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                    {{ pair.right?.lineNo ?? '' }}
                  </td>
                  <td class="line-content mono sbs-content" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                    <span v-html="safeHtml(pair.rightHtml ?? (pair.right ? hl(pair.right.content) : '')) || '\u00a0'"></span>
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
  font-size: var(--text-md);
  font-weight: var(--font-semibold);
  flex-shrink: 0;
}

.fhv-file-path {
  font-size: var(--text-xs);
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
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.fhv-tab:hover {
  color: var(--color-text);
}

.fhv-tab--active {
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  box-shadow: var(--shadow-xs);
}

/* ─── Pickaxe search bar ────────────────────────────────── */
.fhv-pickaxe-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.fhv-pickaxe-modes {
  display: flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.fhv-pickaxe-mode {
  padding: 1px 6px;
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  font-family: var(--font-mono, monospace);
  background: transparent;
  color: var(--color-text-muted);
  border: none;
  cursor: pointer;
}

.fhv-pickaxe-mode--active {
  background: var(--color-accent);
  color: var(--color-accent-text);
}

.fhv-pickaxe-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font-size: var(--font-size-xs);
  color: var(--color-text);
  padding: 2px 0;
}

.fhv-pickaxe-input::placeholder { color: var(--color-text-muted); }

.fhv-pickaxe-clear {
  font-size: 10px;
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0 2px;
  flex-shrink: 0;
}

.fhv-range-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  background: var(--color-accent-soft, rgba(124,58,237,0.06));
  border-bottom: 1px solid var(--color-border);
}

.fhv-pickaxe-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-danger, #ef4444);
}

.fhv-pickaxe-empty {
  padding: var(--space-4) var(--space-3);
  font-size: var(--font-size-sm);
}

/* ─── Blame range-history button ─────────────────────────── */
.fhv-blame-range-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  border: none;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
  vertical-align: middle;
}

.fhv-blame-meta:hover .fhv-blame-range-btn,
.fhv-blame-line:hover .fhv-blame-range-btn {
  opacity: 1;
}

.fhv-blame-range-btn:hover {
  color: var(--color-accent);
}

.fhv-algo-select {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  cursor: pointer;
  outline: none;
  flex-shrink: 0;
  margin-right: var(--space-1);
}

.fhv-algo-select:hover,
.fhv-algo-select:focus {
  border-color: var(--color-accent);
  color: var(--color-text);
}

.fhv-close {
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: var(--radius-sm);
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
  font-size: var(--text-xs);
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
  font-size: var(--text-xs);
  color: var(--color-accent);
  cursor: pointer;
  margin-right: 6px;
}

.fhv-blame-hash:hover {
  text-decoration: underline;
}

/* Tight-packing override for the blame row — the default 30×30 icon
   button would push the row too tall. Also stays semi-transparent at
   rest (previously opacity:0 made it a hidden easter egg). */
.fhv-blame-explain {
  width: 22px;
  height: 22px;
  min-height: 22px;
  padding: 0;
  margin-right: 6px;
  font-size: 10px;
  opacity: 0.5;
  transition: opacity var(--transition-fast);
}

.fhv-blame-line:hover .fhv-blame-explain,
.fhv-blame-explain--active {
  opacity: 1;
}

.fhv-blame-explain--active {
  background: var(--color-ai);
  color: var(--color-ai-text);
}

.fhv-blame-explain-panel {
  position: sticky;
  bottom: 0;
  background: var(--color-bg);
  border-top: 1px solid var(--color-accent);
  padding: 10px 14px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.12);
  z-index: 2;
}

.fhv-blame-explain-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.fhv-blame-explain-title {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-ai);
}

.fhv-blame-explain-close {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.fhv-blame-explain-close:hover { color: var(--color-text); }

.fhv-blame-explain-body {
  font-size: var(--text-sm);
  line-height: 1.45;
  color: var(--color-text);
}

.fhv-blame-explain-error {
  color: var(--color-danger, #ef4444);
}

.fhv-blame-author {
  color: var(--color-text);
  font-weight: var(--font-medium);
  margin-right: 6px;
}

.fhv-blame-date {
  font-size: var(--text-xs);
}

.fhv-blame-lineno {
  width: 44px;
  min-width: 44px;
  padding: 0 6px;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--color-border);
}

.fhv-blame-content {
  padding: 0 10px;
  font-size: var(--text-base);
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
  transition: background var(--transition-fast);
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
  border: 1.5px solid currentColor;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-base);
  font-weight: var(--font-bold);
  flex-shrink: 0;
}

.fhv-log-info {
  flex: 1;
  min-width: 0;
}

.fhv-log-message {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--color-text);
  line-height: 1.3;
}

.fhv-log-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  margin-top: 3px;
}

.fhv-log-sep {
  opacity: 0.4;
}

.fhv-log-hash {
  font-size: var(--text-xs);
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
  font-size: var(--text-base);
  border-bottom: 1px solid var(--color-border);
}

.fhv-compare-hint--active {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.fhv-compare-clear {
  padding: 2px 8px;
  font-size: var(--text-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.fhv-compare-btn:hover {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

/* Selected log entries */
.fhv-log-entry--from {
  background: var(--color-accent-soft);
  border-left: 3px solid var(--color-accent);
}

.fhv-log-entry--to {
  background: var(--color-success-soft);
  border-left: 3px solid var(--color-success);
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
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  cursor: pointer;
  transition: background var(--transition-fast);
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
  font-size: var(--text-base);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.fhv-compare-label--from {
  color: var(--color-accent);
  font-weight: var(--font-semibold);
}

.fhv-compare-label--to {
  color: var(--color-success);
  font-weight: var(--font-semibold);
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
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
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
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--color-border);
}

.line-content {
  padding: 0 10px;
  font-size: var(--text-base);
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
  background: var(--color-danger-soft);
}

.sbs-cell--add {
  background: var(--color-success-soft);
}

.sbs-cell--empty {
  background: var(--color-bg-tertiary);
}
</style>

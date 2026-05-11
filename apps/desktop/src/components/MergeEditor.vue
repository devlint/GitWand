<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { ConflictFile } from "../composables/useGitWand";
import type { ConflictHunk } from "@gitwand/core";
import { highlightConflict } from "../utils/diffHighlight";
import { useI18n } from "../composables/useI18n";
import { safeHtml } from "../composables/useSafeHtml";
import { useAIProvider, type ConflictContext } from "../composables/useAIProvider";

import { useHunkExplanation } from "../composables/useHunkExplanation";
import { useCustomAutomations } from "../composables/useCustomAutomations";
import {
  useResolutionMemory,
  detectPattern,
  applyMemory,
  type ResolutionStrategy,
} from "../composables/useResolutionMemory";
import LlmTracePanel from "./LlmTracePanel.vue";

const { t, locale } = useI18n();
const { isAvailable: aiAvailable, isLoading: aiLoading, lastError: aiError, suggest: aiSuggest } = useAIProvider();
const { isGenerating: aiExplainLoading, explain: aiExplain } = useHunkExplanation();
const { findMatchingRule, executeRule } = useCustomAutomations();
const { findMemory, saveMemory, markUsed, detectPattern: _dp, applyMemory: _am } = useResolutionMemory();

const props = defineProps<{
  file: ConflictFile;
  /** Repo root, needed by custom automations and memory apply */
  cwd?: string;
}>();

type ManualChoice = "ours" | "theirs" | "both" | "both-theirs-first";

const emit = defineEmits<{
  resolve: [path: string];
  resolveHunk: [path: string, hunkIndex: number, choice: ManualChoice];
  resolveHunkCustom: [path: string, hunkIndex: number, content: string];
  /** Custom automation ran and committed; parent should refresh status */
  automationDone: [commitHash: string];
}>();

// ─── Inline Edit State ──────────────────────────────────
const editingHunkIndex = ref<number | null>(null);
const editContent = ref("");

watch(
  () => props.file.path,
  () => {
    editingHunkIndex.value = null;
    editContent.value = "";
  },
);

function startEditing(hunkIndex: number, hunk: ConflictHunk) {
  editContent.value = [...hunk.oursLines, ...hunk.theirsLines].join("\n");
  editingHunkIndex.value = hunkIndex;
}

function cancelEditing() {
  editingHunkIndex.value = null;
  editContent.value = "";
}

function validateEditing(hunkIndex: number) {
  resolveHunkCustomWithMemory(props.file.path, hunkIndex, editContent.value);
  editingHunkIndex.value = null;
  editContent.value = "";
}

// ─── AI Suggestion ─────────────────────────────────────
const aiSuggestionHunkIndex = ref<number | null>(null);
const aiSuggestionContent = ref<string | null>(null);
const aiSuggestionExplanation = ref<string | null>(null);

async function requestAISuggestion(hunkIndex: number, hunk: ConflictHunk) {
  aiSuggestionHunkIndex.value = hunkIndex;
  aiSuggestionContent.value = null;
  aiSuggestionExplanation.value = null;

  const ctx: ConflictContext = {
    filePath: props.file.path,
    base: hunk.baseLines?.join("\n") ?? "",
    ours: hunk.oursLines.join("\n"),
    theirs: hunk.theirsLines.join("\n"),
  };

  try {
    const suggestion = await aiSuggest(ctx);
    aiSuggestionContent.value = suggestion.resolvedContent;
    aiSuggestionExplanation.value = suggestion.explanation;
    // Pre-fill the edit area so user can review and tweak
    editContent.value = suggestion.resolvedContent;
    editingHunkIndex.value = hunkIndex;
  } catch {
    // Error is already in aiError ref
    aiSuggestionHunkIndex.value = null;
  }
}

function dismissAISuggestion() {
  aiSuggestionHunkIndex.value = null;
  aiSuggestionContent.value = null;
  aiSuggestionExplanation.value = null;
}

// ─── AI Explanation (Phase 1.3.2) ───────────────────────
const hunkExplanations = ref<Record<number, string>>({});
const explanationHunkIndex = ref<number | null>(null);
const explanationError = ref<string | null>(null);

async function requestHunkExplanation(hunkIndex: number, hunk: ConflictHunk) {
  explanationError.value = null;
  // Toggle off if already open for this hunk
  if (explanationHunkIndex.value === hunkIndex && hunkExplanations.value[hunkIndex]) {
    explanationHunkIndex.value = null;
    return;
  }
  explanationHunkIndex.value = hunkIndex;
  try {
    const text = await aiExplain(hunk, {
      locale: locale.value,
      filePath: props.file.path,
    });
    hunkExplanations.value = { ...hunkExplanations.value, [hunkIndex]: text };
  } catch (err: any) {
    explanationError.value = err?.message ?? String(err);
  }
}

function dismissExplanation() {
  explanationHunkIndex.value = null;
  explanationError.value = null;
}

// ─── Custom Automation banner ───────────────────────────
const matchingRule = computed(() => findMatchingRule(props.file.path));
const automationRunning = ref(false);
const automationOutput = ref<string | null>(null);
const automationError = ref<string | null>(null);

async function runAutomation() {
  if (!matchingRule.value || !props.cwd) return;
  automationRunning.value = true;
  automationOutput.value = null;
  automationError.value = null;
  try {
    const result = await executeRule(props.cwd, matchingRule.value, props.file.path);
    automationOutput.value = result.output;
    if (result.commitHash) {
      emit("automationDone", result.commitHash);
    }
  } catch (err: any) {
    automationError.value = err?.message ?? String(err);
  } finally {
    automationRunning.value = false;
  }
}

function dismissAutomation() {
  automationOutput.value = null;
  automationError.value = null;
}

// ─── Resolution Memory ──────────────────────────────────
/** After a manual choice, offer to remember it for this file. */
const memoryOfferHunkIndex = ref<number | null>(null);
const memoryOfferStrategy = ref<ResolutionStrategy | null>(null);
const memoryOfferContent = ref<string | null>(null);

/** The stored memory for the current file, if any. */
const fileMemory = computed(() => findMemory(props.file.path));

function offerMemory(hunkIndex: number, strategy: ResolutionStrategy, resolvedContent: string | null = null) {
  memoryOfferHunkIndex.value = hunkIndex;
  memoryOfferStrategy.value = strategy;
  memoryOfferContent.value = resolvedContent;
}

function acceptMemoryOffer() {
  if (!memoryOfferStrategy.value) return;
  const label = `${memoryOfferStrategy.value} — ${props.file.path.split("/").pop()}`;
  saveMemory(props.file.path, memoryOfferStrategy.value, label, memoryOfferContent.value);
  dismissMemoryOffer();
}

function dismissMemoryOffer() {
  memoryOfferHunkIndex.value = null;
  memoryOfferStrategy.value = null;
  memoryOfferContent.value = null;
}

function applyFileMemory(hunkIndex: number, hunk: ConflictHunk) {
  if (!fileMemory.value) return;
  const resolved = applyMemory(fileMemory.value, hunk);
  if (resolved !== null) {
    markUsed(fileMemory.value.id);
    emit("resolveHunkCustom", props.file.path, hunkIndex, resolved);
  }
}

/** Auto-detect learnable pattern when both sides share the same shape. */
function autoDetectPattern(hunk: ConflictHunk): ResolutionStrategy | null {
  const o = hunk.oursLines.join("\n");
  const th = hunk.theirsLines.join("\n");
  return detectPattern(o, th);
}

// ─── Override resolveHunk to capture memory offer ───────
function resolveHunkWithMemory(path: string, hunkIndex: number, choice: ManualChoice) {
  emit("resolveHunk", path, hunkIndex, choice);
  const strategy: ResolutionStrategy = choice === "ours" ? "ours"
    : choice === "theirs" ? "theirs"
    : "both";
  // Surface a "remember this?" toast after a brief delay so it doesn't clash with animations
  setTimeout(() => offerMemory(hunkIndex, strategy), 200);
}

function resolveHunkCustomWithMemory(path: string, hunkIndex: number, content: string) {
  emit("resolveHunkCustom", path, hunkIndex, content);
  // For custom edits, try to detect an auto-learnable pattern
  const hunk = hunks.value[hunkIndex];
  if (hunk) {
    const autoStrategy = autoDetectPattern(hunk);
    const strategy: ResolutionStrategy = autoStrategy ?? "custom";
    setTimeout(() => offerMemory(hunkIndex, strategy, content), 200);
  }
}

// ─── v2.5 — LLM trace UX state ─────────────────────────
//
// `llm_proposed` hunks come back from the core with an audit trail
// (`hunk.trace.llmTrace`). The user can:
//   - accept (default) → resolution applies through the normal auto-resolve
//     path, the panel just locks in visually
//   - reject → this specific hunk is downgraded to "needs manual handling",
//     even though the rest of the file's `llm_proposed` hunks stay accepted
//
// We track rejection client-side (per file path) because the core has
// already produced the resolution — we don't want to re-run it. The set
// is reset when the active file changes.
const rejectedLlmHunks = ref<Set<number>>(new Set());

watch(
  () => props.file.path,
  () => {
    rejectedLlmHunks.value = new Set();
  },
);

/** Number of `llm_proposed` hunks the user explicitly rejected (this file). */
const rejectedLlmCount = computed(() => rejectedLlmHunks.value.size);

/**
 * `file.result.stats.autoResolved` counts every hunk the core marked as
 * auto-resolvable, including `llm_proposed` ones. If the user rejected
 * some, we should not light up the "Resolve auto" button on their
 * behalf. Subtract rejections so the count reflects what *would*
 * actually be applied.
 */
const canResolve = computed(
  () => props.file.result.stats.autoResolved - rejectedLlmCount.value > 0,
);

const hunks = computed(() => props.file.result.hunks);

/** Does a given hunk carry an `llm_proposed` decision with a trace? */
function hasLlmTrace(hunk: ConflictHunk): boolean {
  return (
    hunk.type === "llm_proposed" &&
    hunk.trace?.llmTrace != null
  );
}

/**
 * Should we show the LLM panel for this hunk? Hidden after rejection so
 * the user falls back to the 3-way diff (already rendered below).
 */
function showLlmPanelFor(hunkIndex: number, hunk: ConflictHunk): boolean {
  if (!hasLlmTrace(hunk)) return false;
  if (rejectedLlmHunks.value.has(hunkIndex)) return false;
  return true;
}

/** Visual badge — `true` once the user clicked Accept. UX-only, no state mutation. */
const acceptedLlmHunks = ref<Set<number>>(new Set());

watch(
  () => props.file.path,
  () => {
    acceptedLlmHunks.value = new Set();
  },
);

function onLlmAccept(hunkId: string | number) {
  const idx = Number(hunkId);
  if (!Number.isFinite(idx)) return;
  acceptedLlmHunks.value = new Set([...acceptedLlmHunks.value, idx]);
}

function onLlmReject(hunkId: string | number) {
  const idx = Number(hunkId);
  if (!Number.isFinite(idx)) return;
  // Use a fresh Set so reactivity fires (computed `canResolve` recomputes).
  const next = new Set(rejectedLlmHunks.value);
  next.add(idx);
  rejectedLlmHunks.value = next;
  // Drop a previously-recorded accept so the UX badge doesn't lie.
  if (acceptedLlmHunks.value.has(idx)) {
    const a = new Set(acceptedLlmHunks.value);
    a.delete(idx);
    acceptedLlmHunks.value = a;
  }
}

/** Parse file content into displayable segments (code + conflict hunks). */
interface Segment {
  type: "code" | "conflict";
  lines: string[];
  /** 1-based line number of the first line in the raw file */
  startLine: number;
  hunkIndex?: number;
  /** 1-based line number of the first "ours" line (conflict only) */
  oursStart?: number;
  /** 1-based line number of the first "base" line (diff3 only) */
  baseStart?: number | null;
  /** 1-based line number of the first "theirs" line (conflict only) */
  theirsStart?: number;
}

const segments = computed<Segment[]>(() => {
  const content = props.file.content;
  const lines = content.split("\n");
  const result: Segment[] = [];
  let current: string[] = [];
  let currentStart = 1;
  let inConflict = false;
  let hunkIdx = 0;
  let conflictLines: string[] = [];
  let conflictStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.startsWith("<<<<<<<")) {
      if (current.length > 0) {
        result.push({ type: "code", lines: [...current], startLine: currentStart });
        current = [];
      }
      inConflict = true;
      conflictLines = [line];
      conflictStart = lineNo;
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      conflictLines.push(line);
      const hunk = hunks.value[hunkIdx];
      const oursLen = hunk?.oursLines.length ?? 0;
      const baseLen = hunk?.baseLines.length ?? 0;
      const hasBase = baseLen > 0;
      // Layout inside the conflict block:
      //   <<<<<<< (conflictStart)
      //   ...ours lines...          → oursStart
      //   ||||||| (diff3 only)
      //   ...base lines...          → baseStart
      //   =======
      //   ...theirs lines...        → theirsStart
      //   >>>>>>>
      const oursStart = conflictStart + 1;
      const baseStart = hasBase ? oursStart + oursLen + 1 : null;
      const theirsStart = hasBase
        ? (baseStart as number) + baseLen + 1
        : oursStart + oursLen + 1;
      result.push({
        type: "conflict",
        lines: [...conflictLines],
        hunkIndex: hunkIdx,
        startLine: conflictStart,
        oursStart,
        baseStart,
        theirsStart,
      });
      hunkIdx++;
      conflictLines = [];
      inConflict = false;
      currentStart = lineNo + 1;
    } else if (inConflict) {
      conflictLines.push(line);
    } else {
      if (current.length === 0) currentStart = lineNo;
      current.push(line);
    }
  }

  if (current.length > 0) {
    result.push({ type: "code", lines: current, startLine: currentStart });
  }

  return result;
});

function hunkForSegment(seg: Segment): ConflictHunk | undefined {
  if (seg.hunkIndex == null) return undefined;
  return hunks.value[seg.hunkIndex];
}

function isAutoResolvable(hunk: ConflictHunk): boolean {
  return hunk.type !== "complex" && hunk.confidence.label !== "low";
}

/**
 * Compute a recommendation for a hunk, if possible.
 * Returns the recommended choice or null if no clear recommendation.
 */
function recommendation(hunk: ConflictHunk): ManualChoice | null {
  // one_side_change: only one side modified → take the modified side
  if (hunk.type === "one_side_change") {
    // If ours == base, theirs has the change
    const oursMatchBase =
      hunk.oursLines.join("\n") === hunk.baseLines.join("\n");
    const theirsMatchBase =
      hunk.theirsLines.join("\n") === hunk.baseLines.join("\n");
    if (oursMatchBase && !theirsMatchBase) return "theirs";
    if (theirsMatchBase && !oursMatchBase) return "ours";
  }
  // same_change: both sides did the same thing → either is fine
  if (hunk.type === "same_change") return "ours";
  // whitespace_only: pick theirs (incoming) by convention
  if (hunk.type === "whitespace_only") return "theirs";
  // delete_no_change: one side deleted, other untouched → accept the deletion
  if (hunk.type === "delete_no_change") {
    if (hunk.oursLines.length === 0) return "ours";
    if (hunk.theirsLines.length === 0) return "theirs";
  }
  // non_overlapping: both added at different places → keep both
  if (hunk.type === "non_overlapping") return "both";
  return null;
}

function isRecommended(hunk: ConflictHunk, choice: ManualChoice): boolean {
  return recommendation(hunk) === choice;
}

/** Pre-computed highlighted HTML for each hunk, keyed by hunkIndex. */
const highlightedHunks = computed(() => {
  const map = new Map<number, ReturnType<typeof highlightConflict>>();
  for (let i = 0; i < hunks.value.length; i++) {
    const h = hunks.value[i];
    map.set(i, highlightConflict(h.oursLines, h.baseLines, h.theirsLines));
  }
  return map;
});

/** Per-line highlighted HTML array, used to pair each line with its line number. */
function highlightedLines(hunkIndex: number, panel: "ours" | "base" | "theirs"): string[] {
  const hl = highlightedHunks.value.get(hunkIndex);
  if (!hl) return [];
  return hl[panel].lines;
}

// ─── Minimap ───────────────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const minimapCanvas = ref<HTMLCanvasElement | null>(null);
const MINIMAP_WIDTH = 48;

type MinimapLineKind = "code" | "conflict-auto" | "conflict-manual";

/** Flattened list of line kinds for minimap rendering, one entry per raw line. */
const allLineKinds = computed<MinimapLineKind[]>(() => {
  const kinds: MinimapLineKind[] = [];
  for (const seg of segments.value) {
    if (seg.type === "code") {
      for (let i = 0; i < seg.lines.length; i++) kinds.push("code");
    } else {
      const hunk = seg.hunkIndex != null ? hunks.value[seg.hunkIndex] : undefined;
      const kind: MinimapLineKind =
        hunk && isAutoResolvable(hunk) ? "conflict-auto" : "conflict-manual";
      for (let i = 0; i < seg.lines.length; i++) kinds.push(kind);
    }
  }
  return kinds;
});

function drawMinimap() {
  const canvas = minimapCanvas.value;
  if (!canvas) return;
  const kinds = allLineKinds.value;
  if (kinds.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const containerHeight = canvas.parentElement?.clientHeight ?? 300;
  canvas.width = MINIMAP_WIDTH * dpr;
  canvas.height = containerHeight * dpr;
  canvas.style.width = `${MINIMAP_WIDTH}px`;
  canvas.style.height = `${containerHeight}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, MINIMAP_WIDTH, containerHeight);

  const lineH = Math.max(1, containerHeight / kinds.length);

  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    if (k === "code") continue; // skip for a cleaner look
    ctx.fillStyle =
      k === "conflict-auto"
        ? "rgba(34, 197, 94, 0.6)" // green — auto-resolvable
        : "rgba(239, 68, 68, 0.6)"; // red — needs manual attention
    ctx.fillRect(0, i * lineH, MINIMAP_WIDTH, Math.max(lineH, 2));
  }

  // Viewport indicator
  const contentArea = contentEl.value;
  if (contentArea && contentArea.scrollHeight > 0) {
    const ratio = contentArea.scrollTop / contentArea.scrollHeight;
    const visibleRatio = contentArea.clientHeight / contentArea.scrollHeight;
    const vpY = ratio * containerHeight;
    const vpH = Math.max(visibleRatio * containerHeight, 10);
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.fillRect(0, vpY, MINIMAP_WIDTH, vpH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpY + 0.5, MINIMAP_WIDTH - 1, vpH - 1);
  }
}

function onMinimapClick(e: MouseEvent) {
  const canvas = minimapCanvas.value;
  const contentArea = contentEl.value;
  if (!canvas || !contentArea) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const ratio = y / rect.height;
  contentArea.scrollTop = ratio * contentArea.scrollHeight - contentArea.clientHeight / 2;
}

function onContentScroll() {
  drawMinimap();
}

watch(allLineKinds, () => nextTick(drawMinimap));
watch(
  () => props.file.path,
  () => nextTick(drawMinimap),
);

onMounted(() => {
  nextTick(drawMinimap);
  if (typeof ResizeObserver !== "undefined" && contentEl.value) {
    const ro = new ResizeObserver(() => drawMinimap());
    ro.observe(contentEl.value);
  }
});
</script>

<template>
  <div class="merge-editor">
    <!-- File header bar -->
    <div class="editor-header">
      <div class="editor-file-info">
        <span class="editor-filename mono">{{ file.path }}</span>
        <span class="editor-stats muted">
          {{ file.result.stats.totalConflicts }} {{ t('merge.conflictType') }}{{ file.result.stats.totalConflicts > 1 ? 's' : '' }}
          <template v-if="file.result.stats.autoResolved > 0">
            — {{ file.result.stats.autoResolved }} {{ t('merge.autoResolved') }}
          </template>
        </span>
      </div>
      <button
        v-if="canResolve"
        class="btn btn--resolve"
        @click="emit('resolve', file.path)"
        :aria-label="t('merge.resolveAutoLabel')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/>
        </svg>
        {{ t('merge.resolveAuto') }}
      </button>
    </div>

    <!-- Custom Automation banner -->
    <div v-if="matchingRule" class="me-automation-banner">
      <div class="me-automation-body">
        <svg class="me-automation-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
        <span class="me-automation-text">
          <strong>{{ matchingRule.name }}</strong> —
          <code>{{ matchingRule.command }}</code>
        </span>
      </div>
      <div class="me-automation-actions">
        <span v-if="automationRunning" class="me-automation-running">{{ t("mergeEditor.automationRunning") }}</span>
        <template v-else>
          <button class="me-automation-btn me-automation-btn--run" :disabled="automationRunning" @click="runAutomation">
            {{ t("mergeEditor.automationRun") }}
          </button>
          <button class="me-automation-btn me-automation-btn--dismiss" @click="dismissAutomation">×</button>
        </template>
      </div>
    </div>

    <!-- Automation output / error -->
    <div v-if="automationOutput !== null || automationError !== null" class="me-automation-result" :class="{ 'me-automation-result--error': !!automationError }">
      <pre class="me-automation-output">{{ automationError ?? automationOutput }}</pre>
      <button class="me-automation-btn me-automation-btn--dismiss" @click="dismissAutomation">{{ t("common.close") }}</button>
    </div>

    <!-- Resolution Memory suggestion banner -->
    <div v-if="fileMemory && !matchingRule" class="me-memory-banner">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-1.5h1.5v1.5zm0-3h-1.5V4.5h1.5V8.5z"/>
      </svg>
      <span class="me-memory-text">{{ t("mergeEditor.memoryBannerHint", fileMemory.description) }}</span>
    </div>

    <!-- Memory offer toast (after a manual choice) -->
    <div v-if="memoryOfferHunkIndex !== null" class="me-memory-offer">
      <span>{{ t("mergeEditor.memorySaveOffer") }}</span>
      <button class="me-memory-btn me-memory-btn--save" @click="acceptMemoryOffer">{{ t("mergeEditor.memorySave") }}</button>
      <button class="me-memory-btn" @click="dismissMemoryOffer">{{ t("common.close") }}</button>
    </div>

    <!-- Editor body: code + minimap -->
    <div class="merge-body">
    <div
      class="editor-content"
      ref="contentEl"
      role="document"
      :aria-label="file.path"
      @scroll="onContentScroll"
    >
      <div
        v-for="(seg, i) in segments"
        :key="i"
        :class="['segment', `segment--${seg.type}`]"
      >
        <!-- Normal code lines -->
        <template v-if="seg.type === 'code'">
          <table class="merge-code-table mono">
            <tbody>
              <tr
                v-for="(line, j) in seg.lines"
                :key="j"
                class="merge-code-row"
              >
                <td class="line-no mono">{{ seg.startLine + j }}</td>
                <td class="line-content mono">{{ line || '\u00a0' }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- Conflict hunk -->
        <template v-else>
          <div class="conflict-hunk" :class="{ 'conflict-hunk--resolvable': hunkForSegment(seg) && isAutoResolvable(hunkForSegment(seg)!) }">

            <!-- ── v2.5 LLM trace audit (when llm_proposed and not rejected) ─── -->
            <LlmTracePanel
              v-if="hunkForSegment(seg) && seg.hunkIndex != null && showLlmPanelFor(seg.hunkIndex, hunkForSegment(seg)!)"
              :trace="hunkForSegment(seg)!.trace.llmTrace!"
              :file-path="file.path"
              :hunk-id="seg.hunkIndex"
              @accept="onLlmAccept"
              @reject="onLlmReject"
            />

            <!-- ── VS Code-style inline action bar ─────────── -->
            <div class="inline-actions" v-if="hunkForSegment(seg) && editingHunkIndex !== seg.hunkIndex">
              <a
                class="inline-action inline-action--current"
                :class="{ 'inline-action--recommended': isRecommended(hunkForSegment(seg)!, 'ours') }"
                href="#"
                @click.prevent="resolveHunkWithMemory(file.path, seg.hunkIndex!, 'ours')"
              >{{ t('merge.acceptCurrent') }}<svg v-if="isRecommended(hunkForSegment(seg)!, 'ours')" class="recommend-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z"/></svg></a>
              <span class="inline-sep">|</span>
              <a
                class="inline-action inline-action--incoming"
                :class="{ 'inline-action--recommended': isRecommended(hunkForSegment(seg)!, 'theirs') }"
                href="#"
                @click.prevent="resolveHunkWithMemory(file.path, seg.hunkIndex!, 'theirs')"
              >{{ t('merge.acceptIncoming') }}<svg v-if="isRecommended(hunkForSegment(seg)!, 'theirs')" class="recommend-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z"/></svg></a>
              <span class="inline-sep">|</span>
              <a
                class="inline-action inline-action--both"
                :class="{ 'inline-action--recommended': isRecommended(hunkForSegment(seg)!, 'both') }"
                href="#"
                @click.prevent="resolveHunkWithMemory(file.path, seg.hunkIndex!, 'both')"
              >{{ t('merge.acceptBoth') }}<svg v-if="isRecommended(hunkForSegment(seg)!, 'both')" class="recommend-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z"/></svg></a>
              <span class="inline-sep">|</span>
              <a
                class="inline-action inline-action--edit"
                href="#"
                @click.prevent="startEditing(seg.hunkIndex!, hunkForSegment(seg)!)"
              >{{ t('merge.customEdit') }}</a>
              <template v-if="aiAvailable">
                <span class="inline-sep">|</span>
                <a
                  class="inline-action inline-action--ai"
                  :class="{ 'inline-action--loading': aiLoading && aiSuggestionHunkIndex === seg.hunkIndex }"
                  href="#"
                  @click.prevent="requestAISuggestion(seg.hunkIndex!, hunkForSegment(seg)!)"
                >
                  <svg class="ai-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 1v2m0 10v2M1 8h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41"/>
                    <circle cx="8" cy="8" r="3"/>
                  </svg>
                  {{ aiLoading && aiSuggestionHunkIndex === seg.hunkIndex ? t('mergeEditor.aiLoading') : t('mergeEditor.aiButton') }}
                </a>
                <span class="inline-sep">|</span>
                <a
                  class="inline-action inline-action--explain"
                  :class="{ 'inline-action--loading': aiExplainLoading && explanationHunkIndex === seg.hunkIndex }"
                  href="#"
                  :title="t('mergeEditor.explainTooltip')"
                  @click.prevent="requestHunkExplanation(seg.hunkIndex!, hunkForSegment(seg)!)"
                >
                  <svg class="ai-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <path d="M8 14.5a.75.75 0 0 0 .75-.75v-1h-1.5v1a.75.75 0 0 0 .75.75Z" fill="currentColor" stroke="none"/>
                    <path d="M8 1.5a4.5 4.5 0 0 0-3 7.85V11h6V9.35A4.5 4.5 0 0 0 8 1.5Z"/>
                  </svg>
                  {{ aiExplainLoading && explanationHunkIndex === seg.hunkIndex ? t('mergeEditor.explainAnalyzing') : t('mergeEditor.explain') }}
                </a>
              </template>
              <template v-if="fileMemory">
                <span class="inline-sep">|</span>
                <a
                  class="inline-action inline-action--memory"
                  href="#"
                  :title="fileMemory.description"
                  @click.prevent="applyFileMemory(seg.hunkIndex!, hunkForSegment(seg)!)"
                >
                  <svg class="ai-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm1 10H7v-1.5h2V11zm0-3H7V5h2v3z"/>
                  </svg>
                  {{ t('mergeEditor.memoryApply') }}
                </a>
              </template>
              <span
                v-if="recommendation(hunkForSegment(seg)!) !== null"
                class="inline-badge inline-badge--recommended"
              >{{ t('merge.recommended') }}</span>
            </div>

            <!-- ── AI error banner ──────────────────────── -->
            <div v-if="aiError && aiSuggestionHunkIndex === seg.hunkIndex" class="ai-error-banner">
              <span>{{ t('mergeEditor.aiErrorPrefix') }} : {{ aiError }}</span>
              <a href="#" @click.prevent="dismissAISuggestion" class="ai-error-close">OK</a>
            </div>

            <!-- ── AI explanation banner ──────────────────── -->
            <div v-if="aiSuggestionExplanation && editingHunkIndex === seg.hunkIndex && aiSuggestionHunkIndex === seg.hunkIndex" class="ai-explanation-banner">
              <svg class="ai-explanation-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <path d="M8 1v2m0 10v2M1 8h2m10 0h2"/><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>
              </svg>
              <span>{{ aiSuggestionExplanation }}</span>
            </div>

            <!-- ── Hunk NL explanation (Phase 1.3.2) ──────── -->
            <div v-if="explanationHunkIndex === seg.hunkIndex && (hunkExplanations[seg.hunkIndex!] || aiExplainLoading || explanationError)" class="hunk-explanation-banner" role="status" aria-live="polite">
              <svg class="hunk-explanation-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                <path d="M8 1.5a4.5 4.5 0 0 0-3 7.85V11h6V9.35A4.5 4.5 0 0 0 8 1.5Z"/>
                <path d="M6.5 13h3M7 14.5h2"/>
              </svg>
              <span v-if="explanationError" class="hunk-explanation-error">{{ explanationError }}</span>
              <span v-else-if="aiExplainLoading && !hunkExplanations[seg.hunkIndex!]">{{ t('mergeEditor.analyzingConflict') }}</span>
              <span v-else>{{ hunkExplanations[seg.hunkIndex!] }}</span>
              <a v-if="!aiExplainLoading" class="hunk-explanation-close" href="#" @click.prevent="dismissExplanation">✕</a>
            </div>

            <!-- ── Inline Edit Mode ─────────────────────── -->
            <div v-if="editingHunkIndex === seg.hunkIndex" class="hunk-edit">
              <div class="edit-header">
                <span class="edit-label">{{ aiSuggestionHunkIndex === seg.hunkIndex ? t('mergeEditor.aiSuggestionLabel') : t('merge.customEdit') }}</span>
                <div class="edit-actions-inline">
                  <a
                    class="inline-action inline-action--validate"
                    href="#"
                    @click.prevent="validateEditing(seg.hunkIndex!)"
                  >{{ t('common.confirm') }}</a>
                  <span class="inline-sep">|</span>
                  <a
                    class="inline-action"
                    href="#"
                    @click.prevent="cancelEditing"
                  >{{ t('common.cancel') }}</a>
                </div>
              </div>
              <textarea
                class="edit-textarea mono"
                v-model="editContent"
                :aria-label="`Edit conflict ${seg.hunkIndex}`"
                spellcheck="false"
                rows="8"
              ></textarea>
            </div>

            <!-- ── Two-panel view (ours / theirs) ──────────── -->
            <template v-else>
              <div class="hunk-panels">
                <!-- Current (ours) -->
                <div class="hunk-panel hunk-panel--ours">
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--ours" aria-hidden="true"></span>
                    {{ t('merge.currentBranch') }}
                  </div>
                  <table class="merge-panel-table mono">
                    <tbody>
                      <tr
                        v-for="(lineHtml, j) in highlightedLines(seg.hunkIndex!, 'ours')"
                        :key="j"
                        class="merge-panel-row"
                      >
                        <td class="line-no mono">{{ seg.oursStart! + j }}</td>
                        <td class="line-content mono"><span v-html="safeHtml(lineHtml) || '&nbsp;'"></span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- Base (if diff3) -->
                <div
                  v-if="hunkForSegment(seg) && hunkForSegment(seg)!.baseLines.length > 0 && seg.baseStart != null"
                  class="hunk-panel hunk-panel--base"
                >
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--base" aria-hidden="true"></span>
                    Base
                  </div>
                  <table class="merge-panel-table mono">
                    <tbody>
                      <tr
                        v-for="(lineHtml, j) in highlightedLines(seg.hunkIndex!, 'base')"
                        :key="j"
                        class="merge-panel-row"
                      >
                        <td class="line-no mono">{{ seg.baseStart! + j }}</td>
                        <td class="line-content mono"><span v-html="safeHtml(lineHtml) || '&nbsp;'"></span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- Incoming (theirs) -->
                <div class="hunk-panel hunk-panel--theirs">
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--theirs" aria-hidden="true"></span>
                    {{ t('merge.incomingBranch') }}
                  </div>
                  <table class="merge-panel-table mono">
                    <tbody>
                      <tr
                        v-for="(lineHtml, j) in highlightedLines(seg.hunkIndex!, 'theirs')"
                        :key="j"
                        class="merge-panel-row"
                      >
                        <td class="line-no mono">{{ seg.theirsStart! + j }}</td>
                        <td class="line-content mono"><span v-html="safeHtml(lineHtml) || '&nbsp;'"></span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>

            <!-- Explanation -->
            <div
              v-if="hunkForSegment(seg)?.explanation"
              class="hunk-explanation muted"
            >
              {{ hunkForSegment(seg)!.explanation }}
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Minimap (right-side overview) -->
    <div class="merge-minimap" @click="onMinimapClick">
      <canvas ref="minimapCanvas"></canvas>
    </div>
    </div><!-- /merge-body -->
  </div>
</template>

<style scoped>
.merge-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.editor-file-info {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.editor-filename {
  font-size: var(--text-md);
  font-weight: var(--font-semibold);
}

.editor-stats {
  font-size: var(--text-base);
}

.btn--resolve {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  font-size: var(--text-base);
  font-weight: var(--font-medium);
  background: var(--color-accent);
  color: var(--color-accent-text);
  transition: background var(--transition-base);
}

.btn--resolve:hover {
  background: var(--color-accent-hover);
}

/* ─── Body layout (content + minimap) ──────────────────── */
.merge-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

.editor-content {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  min-width: 0;
}

/* ─── Minimap ──────────────────────────────────────────── */
.merge-minimap {
  width: 48px;
  flex-shrink: 0;
  background: var(--color-bg-secondary);
  border-left: 1px solid var(--color-border);
  cursor: pointer;
  position: relative;
}

.merge-minimap canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.segment--code {
  background: var(--color-bg);
}

/* ─── Line-numbered code table (shared between segments & panels) ─── */
.merge-code-table,
.merge-panel-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.merge-code-row,
.merge-panel-row {
  line-height: 1.6;
}

.merge-code-table .line-no,
.merge-panel-table .line-no {
  width: 48px;
  min-width: 48px;
  padding: 0 8px;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
  opacity: 0.5;
  user-select: none;
  vertical-align: top;
  border-right: 1px solid var(--color-border);
  font-variant-numeric: tabular-nums;
}

.merge-code-table .line-content,
.merge-panel-table .line-content {
  padding: 0 12px;
  font-size: var(--text-base);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  vertical-align: top;
}

.merge-code-table {
  padding: 4px 0;
}

/* ─── Conflict Hunk ────────────────────────────────────── */

.conflict-hunk {
  margin: 2px 0;
  border-left: 3px solid var(--color-danger);
  background: var(--color-danger-soft);
}

.conflict-hunk--resolvable {
  border-left-color: var(--color-success);
  background: var(--color-resolved-bg);
}

/* ─── VS Code-style Inline Actions ─────────────────────── */

.inline-actions {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 6px 20px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.inline-action {
  font-size: var(--text-base);
  font-weight: var(--font-medium);
  text-decoration: none;
  padding: 2px 0;
  cursor: pointer;
  transition: color var(--transition-fast);
  color: var(--color-text-muted);
}

.inline-action:hover {
  text-decoration: underline;
}

.inline-action--current {
  color: var(--color-ours);
}

.inline-action--current:hover {
  color: var(--color-ours);
}

.inline-action--incoming {
  color: var(--color-theirs);
}

.inline-action--incoming:hover {
  color: var(--color-theirs);
}

.inline-action--both {
  color: var(--color-warning);
}

.inline-action--both:hover {
  color: var(--color-warning);
}

.inline-action--edit {
  color: var(--color-text-muted);
}

.inline-action--edit:hover {
  color: var(--color-text);
}

.inline-action--validate {
  color: var(--color-success);
  font-weight: 600;
}

/* ─── AI action ──────────────────────────────────────── */

.inline-action--ai {
  color: var(--color-ai);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-weight: var(--font-semibold);
}

.inline-action--ai:hover {
  color: var(--color-ai-hover);
  opacity: 1;
}

.inline-action--loading {
  opacity: 0.6;
  pointer-events: none;
}

.ai-icon {
  flex-shrink: 0;
}

@keyframes aiPulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.inline-action--loading .ai-icon {
  animation: aiPulse 1s ease-in-out infinite;
}

/* ─── Recommended action ──────────────────────────────── */

.inline-action--recommended {
  font-weight: var(--font-bold);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.recommend-icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.inline-sep {
  color: var(--color-border);
  padding: 0 8px;
  font-size: var(--text-base);
  user-select: none;
}

.inline-badge--recommended {
  margin-left: auto;
  font-size: var(--text-xs);
  font-weight: var(--font-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--color-success-soft);
  color: var(--color-success);
}

/* ─── Two-way Panels ──────────────────────────────────── */

.hunk-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--color-border);
}

.hunk-panel {
  background: var(--color-bg);
  min-width: 0;
}

/* 3-column layout when base is present */
.hunk-panels:has(.hunk-panel--base) {
  grid-template-columns: 1fr 1fr 1fr;
}

.panel-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-subtle);
  border-bottom: 1px solid var(--color-border);
}

.panel-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.panel-dot--ours { background: var(--color-ours); }
.panel-dot--base { background: var(--color-text-muted); }
.panel-dot--theirs { background: var(--color-theirs); }

.hunk-panel--ours .merge-panel-table {
  background: var(--color-ours-bg);
}

.hunk-panel--theirs .merge-panel-table {
  background: var(--color-theirs-bg);
}

.hunk-panel .merge-panel-table {
  padding: 4px 0;
  min-height: 32px;
}

/* ─── Inline Edit ──────────────────────────────────────── */

.hunk-edit {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 20px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.edit-label {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--color-accent);
}

.edit-actions-inline {
  display: flex;
  align-items: center;
  gap: 0;
}

.edit-textarea {
  width: 100%;
  min-height: 120px;
  padding: 12px 20px;
  background: var(--color-bg);
  color: var(--color-text);
  border: none;
  border-bottom: 1px solid var(--color-border);
  font-size: var(--text-md);
  line-height: 1.6;
  resize: vertical;
  outline: none;
  tab-size: 2;
}

.edit-textarea:focus {
  background: var(--color-bg-secondary);
  box-shadow: inset 0 0 0 2px var(--color-accent);
}

/* ─── Diff Highlighting ────────────────────────────────── */

.merge-panel-table :deep(.diff-add) {
  background: var(--color-success-soft);
  border-radius: 2px;
  padding: 0 1px;
}

.hunk-panel--ours .merge-panel-table :deep(.diff-add) {
  background: var(--color-info-soft);
}

.hunk-panel--theirs .merge-panel-table :deep(.diff-add) {
  background: var(--color-accent-soft);
}

.merge-panel-table :deep(.diff-del) {
  background: var(--color-danger-soft);
  border-radius: 2px;
  padding: 0 1px;
  text-decoration: line-through;
  opacity: 0.7;
}

/* ─── Explanation ──────────────────────────────────────── */

.hunk-explanation {
  padding: 6px 20px 8px;
  font-size: var(--text-base);
  font-style: italic;
  border-top: 1px solid var(--color-border);
}

/* ─── AI banners ─────────────────────────────────────── */

.ai-error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-base);
  border-radius: var(--radius-sm);
  margin: 4px 12px;
}

.ai-error-close {
  color: var(--color-danger);
  font-weight: var(--font-semibold);
  font-size: var(--text-xs);
  text-decoration: none;
}

.ai-explanation-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 14px;
  margin: 4px 12px;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-soft);
  border-radius: var(--radius-sm);
  font-size: var(--text-base);
  line-height: 1.4;
  color: var(--color-accent);
}

.ai-explanation-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--color-accent);
}

.hunk-explanation-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 14px;
  margin: 4px 12px;
  background: var(--color-bg-secondary, rgba(148, 163, 184, 0.08));
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-sm);
  font-size: var(--text-base);
  line-height: 1.4;
  color: var(--color-text);
}

.hunk-explanation-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--color-accent);
}

.hunk-explanation-error {
  color: var(--color-danger, #ef4444);
  flex: 1;
}

.hunk-explanation-close {
  margin-left: auto;
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: var(--text-sm);
  padding: 0 4px;
}

.hunk-explanation-close:hover {
  color: var(--color-text);
}

.inline-action--explain {
  color: var(--color-ai);
}
.inline-action--explain:hover {
  color: var(--color-ai-hover);
  opacity: 1;
}

/* Memory action (same tone as AI but green-ish accent) */
.inline-action--memory {
  color: var(--color-success, #22c55e);
  opacity: 0.85;
}
.inline-action--memory:hover {
  opacity: 1;
}

/* ─── Custom Automation banner ─────────────────────────── */
.me-automation-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px;
  background: var(--color-accent-soft);
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
}

.me-automation-body {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.me-automation-icon {
  flex-shrink: 0;
  color: var(--color-accent);
}

.me-automation-text {
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.me-automation-text code {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--color-surface);
  border-radius: 3px;
  padding: 1px 4px;
}

.me-automation-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.me-automation-running {
  font-size: 11px;
  color: var(--color-text-muted);
  font-style: italic;
}

.me-automation-btn {
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  padding: 2px 8px;
  transition: background 0.12s;
}

.me-automation-btn--run {
  color: white;
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.me-automation-btn--run:hover {
  opacity: 0.88;
}

.me-automation-btn--dismiss {
  color: var(--color-text-muted);
}

.me-automation-btn--dismiss:hover {
  background: var(--color-bg-tertiary);
}

.me-automation-result {
  padding: 8px 12px;
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.me-automation-result--error {
  background: var(--color-danger-soft, rgba(239,68,68,.08));
  border-color: var(--color-danger, #ef4444);
}

.me-automation-output {
  flex: 1;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--color-text-primary);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

/* ─── Resolution Memory banner ─────────────────────────── */
.me-memory-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--color-success-soft, rgba(34,197,94,.08));
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-success, #22c55e);
}

.me-memory-text {
  flex: 1;
}

/* ─── Memory offer toast ────────────────────────────────── */
.me-memory-offer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-primary);
}

.me-memory-btn {
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  padding: 2px 7px;
  color: var(--color-text-muted);
  transition: background 0.12s;
}

.me-memory-btn:hover {
  background: var(--color-bg-tertiary);
}

.me-memory-btn--save {
  color: var(--color-success, #22c55e);
  border-color: var(--color-success, #22c55e);
}

.me-memory-btn--save:hover {
  background: var(--color-success-soft, rgba(34,197,94,.12));
}
</style>

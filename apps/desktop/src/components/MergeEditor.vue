<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ConflictFile } from "../composables/useGitWand";
import type { ConflictHunk } from "@gitwand/core";
import { highlightConflict } from "../utils/diffHighlight";
import { useI18n } from "../composables/useI18n";
import { useAIProvider, type ConflictContext } from "../composables/useAIProvider";

import { useHunkExplanation } from "../composables/useHunkExplanation";

const { t, locale } = useI18n();
const { isAvailable: aiAvailable, isLoading: aiLoading, lastError: aiError, suggest: aiSuggest } = useAIProvider();
const { isGenerating: aiExplainLoading, explain: aiExplain } = useHunkExplanation();

const props = defineProps<{
  file: ConflictFile;
}>();

type ManualChoice = "ours" | "theirs" | "both" | "both-theirs-first";

const emit = defineEmits<{
  resolve: [path: string];
  resolveHunk: [path: string, hunkIndex: number, choice: ManualChoice];
  resolveHunkCustom: [path: string, hunkIndex: number, content: string];
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
  emit("resolveHunkCustom", props.file.path, hunkIndex, editContent.value);
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

/** Parse file content into displayable segments (code + conflict hunks). */
interface Segment {
  type: "code" | "conflict";
  lines: string[];
  hunkIndex?: number;
}

const segments = computed<Segment[]>(() => {
  const content = props.file.content;
  const lines = content.split("\n");
  const result: Segment[] = [];
  let current: string[] = [];
  let inConflict = false;
  let hunkIdx = 0;
  let conflictLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      if (current.length > 0) {
        result.push({ type: "code", lines: [...current] });
        current = [];
      }
      inConflict = true;
      conflictLines = [line];
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      conflictLines.push(line);
      result.push({ type: "conflict", lines: [...conflictLines], hunkIndex: hunkIdx });
      hunkIdx++;
      conflictLines = [];
      inConflict = false;
    } else if (inConflict) {
      conflictLines.push(line);
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    result.push({ type: "code", lines: current });
  }

  return result;
});

const canResolve = computed(() => props.file.result.stats.autoResolved > 0);

const hunks = computed(() => props.file.result.hunks);

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

function highlightedHtml(hunkIndex: number, panel: "ours" | "base" | "theirs"): string {
  const hl = highlightedHunks.value.get(hunkIndex);
  if (!hl) return "";
  return hl[panel].lines.join("\n");
}
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

    <!-- Code view -->
    <div class="editor-content" role="document" :aria-label="file.path">
      <div
        v-for="(seg, i) in segments"
        :key="i"
        :class="['segment', `segment--${seg.type}`]"
      >
        <!-- Normal code lines -->
        <template v-if="seg.type === 'code'">
          <pre class="code-block mono"><code><template
            v-for="(line, j) in seg.lines" :key="j"
          >{{ line }}{{ j < seg.lines.length - 1 ? '\n' : '' }}</template></code></pre>
        </template>

        <!-- Conflict hunk -->
        <template v-else>
          <div class="conflict-hunk" :class="{ 'conflict-hunk--resolvable': hunkForSegment(seg) && isAutoResolvable(hunkForSegment(seg)!) }">

            <!-- ── VS Code-style inline action bar ─────────── -->
            <div class="inline-actions" v-if="hunkForSegment(seg) && editingHunkIndex !== seg.hunkIndex">
              <a
                class="inline-action inline-action--current"
                :class="{ 'inline-action--recommended': isRecommended(hunkForSegment(seg)!, 'ours') }"
                href="#"
                @click.prevent="emit('resolveHunk', file.path, seg.hunkIndex!, 'ours')"
              >{{ t('merge.acceptCurrent') }}<svg v-if="isRecommended(hunkForSegment(seg)!, 'ours')" class="recommend-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z"/></svg></a>
              <span class="inline-sep">|</span>
              <a
                class="inline-action inline-action--incoming"
                :class="{ 'inline-action--recommended': isRecommended(hunkForSegment(seg)!, 'theirs') }"
                href="#"
                @click.prevent="emit('resolveHunk', file.path, seg.hunkIndex!, 'theirs')"
              >{{ t('merge.acceptIncoming') }}<svg v-if="isRecommended(hunkForSegment(seg)!, 'theirs')" class="recommend-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z"/></svg></a>
              <span class="inline-sep">|</span>
              <a
                class="inline-action inline-action--both"
                :class="{ 'inline-action--recommended': isRecommended(hunkForSegment(seg)!, 'both') }"
                href="#"
                @click.prevent="emit('resolveHunk', file.path, seg.hunkIndex!, 'both')"
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
                  {{ aiLoading && aiSuggestionHunkIndex === seg.hunkIndex ? 'IA...' : 'IA' }}
                </a>
                <span class="inline-sep">|</span>
                <a
                  class="inline-action inline-action--explain"
                  :class="{ 'inline-action--loading': aiExplainLoading && explanationHunkIndex === seg.hunkIndex }"
                  href="#"
                  :title="locale === 'fr' ? 'Expliquer ce conflit en langage naturel' : 'Explain this conflict in plain language'"
                  @click.prevent="requestHunkExplanation(seg.hunkIndex!, hunkForSegment(seg)!)"
                >
                  <svg class="ai-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <path d="M8 14.5a.75.75 0 0 0 .75-.75v-1h-1.5v1a.75.75 0 0 0 .75.75Z" fill="currentColor" stroke="none"/>
                    <path d="M8 1.5a4.5 4.5 0 0 0-3 7.85V11h6V9.35A4.5 4.5 0 0 0 8 1.5Z"/>
                  </svg>
                  {{ aiExplainLoading && explanationHunkIndex === seg.hunkIndex ? (locale === 'fr' ? 'Analyse…' : 'Analysing…') : (locale === 'fr' ? 'Expliquer' : 'Explain') }}
                </a>
              </template>
              <span
                v-if="recommendation(hunkForSegment(seg)!) !== null"
                class="inline-badge inline-badge--recommended"
              >{{ t('merge.recommended') }}</span>
            </div>

            <!-- ── AI error banner ──────────────────────── -->
            <div v-if="aiError && aiSuggestionHunkIndex === seg.hunkIndex" class="ai-error-banner">
              <span>IA : {{ aiError }}</span>
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
            <div v-if="explanationHunkIndex === seg.hunkIndex && (hunkExplanations[seg.hunkIndex!] || aiExplainLoading || explanationError)" class="hunk-explanation-banner">
              <svg class="hunk-explanation-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                <path d="M8 1.5a4.5 4.5 0 0 0-3 7.85V11h6V9.35A4.5 4.5 0 0 0 8 1.5Z"/>
                <path d="M6.5 13h3M7 14.5h2"/>
              </svg>
              <span v-if="explanationError" class="hunk-explanation-error">{{ explanationError }}</span>
              <span v-else-if="aiExplainLoading && !hunkExplanations[seg.hunkIndex!]">{{ locale === 'fr' ? 'Analyse du conflit en cours…' : 'Analysing conflict…' }}</span>
              <span v-else>{{ hunkExplanations[seg.hunkIndex!] }}</span>
              <a v-if="!aiExplainLoading" class="hunk-explanation-close" href="#" @click.prevent="dismissExplanation">✕</a>
            </div>

            <!-- ── Inline Edit Mode ─────────────────────── -->
            <div v-if="editingHunkIndex === seg.hunkIndex" class="hunk-edit">
              <div class="edit-header">
                <span class="edit-label">{{ aiSuggestionHunkIndex === seg.hunkIndex ? 'Suggestion IA — vérifiez et ajustez' : t('merge.customEdit') }}</span>
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
                  <pre class="panel-code mono"><code v-html="highlightedHtml(seg.hunkIndex!, 'ours')"></code></pre>
                </div>

                <!-- Base (if diff3) -->
                <div
                  v-if="hunkForSegment(seg) && hunkForSegment(seg)!.baseLines.length > 0"
                  class="hunk-panel hunk-panel--base"
                >
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--base" aria-hidden="true"></span>
                    Base
                  </div>
                  <pre class="panel-code mono"><code v-html="highlightedHtml(seg.hunkIndex!, 'base')"></code></pre>
                </div>

                <!-- Incoming (theirs) -->
                <div class="hunk-panel hunk-panel--theirs">
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--theirs" aria-hidden="true"></span>
                    {{ t('merge.incomingBranch') }}
                  </div>
                  <pre class="panel-code mono"><code v-html="highlightedHtml(seg.hunkIndex!, 'theirs')"></code></pre>
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

.editor-content {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.segment--code {
  background: var(--color-bg);
}

.code-block {
  margin: 0;
  padding: 4px 20px;
  font-size: var(--text-md);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
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
  color: var(--color-accent);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-weight: var(--font-semibold);
}

.inline-action--ai:hover {
  color: var(--color-accent);
  opacity: 0.8;
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

.panel-code {
  margin: 0;
  padding: 8px 12px;
  font-size: var(--text-base);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 32px;
}

.hunk-panel--ours .panel-code {
  background: var(--color-ours-bg);
}

.hunk-panel--theirs .panel-code {
  background: var(--color-theirs-bg);
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

.panel-code :deep(.diff-add) {
  background: var(--color-success-soft);
  border-radius: 2px;
  padding: 0 1px;
}

.hunk-panel--ours .panel-code :deep(.diff-add) {
  background: var(--color-info-soft);
}

.hunk-panel--theirs .panel-code :deep(.diff-add) {
  background: var(--color-accent-soft);
}

.panel-code :deep(.diff-del) {
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
  color: var(--color-accent);
}
</style>

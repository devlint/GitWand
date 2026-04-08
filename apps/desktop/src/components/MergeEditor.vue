<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ConflictFile } from "../composables/useGitWand";
import type { ConflictHunk } from "@gitwand/core";
import { highlightConflict } from "../utils/diffHighlight";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

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

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    same_change: "Même changement",
    one_side_change: "Un seul côté modifié",
    delete_no_change: "Suppression sans conflit",
    whitespace_only: "Whitespace uniquement",
    non_overlapping: "Non-chevauchant",
    complex: "Conflit complexe",
  };
  return labels[type] ?? type;
}

function confidenceLabel(conf: string): string {
  const labels: Record<string, string> = {
    certain: "Certain",
    high: "Haute",
    medium: "Moyenne",
    low: "Basse",
  };
  return labels[conf] ?? conf;
}

function isAutoResolvable(hunk: ConflictHunk): boolean {
  return hunk.type !== "complex" && hunk.confidence !== "low";
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
          {{ file.result.stats.totalConflicts }} conflit{{ file.result.stats.totalConflicts > 1 ? 's' : '' }}
          <template v-if="file.result.stats.autoResolved > 0">
            — {{ file.result.stats.autoResolved }} auto-résolvable{{ file.result.stats.autoResolved > 1 ? 's' : '' }}
          </template>
        </span>
      </div>
      <button
        v-if="canResolve"
        class="btn btn--resolve"
        @click="emit('resolve', file.path)"
        :aria-label="`Résoudre les conflits automatiques de ${file.path}`"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/>
        </svg>
        Résoudre auto
      </button>
    </div>

    <!-- Code view -->
    <div class="editor-content" role="document" :aria-label="`Contenu de ${file.path}`">
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
            <!-- Hunk header -->
            <div class="hunk-header">
              <div class="hunk-info" v-if="hunkForSegment(seg)">
                <span
                  class="hunk-type-badge"
                  :class="`hunk-type--${hunkForSegment(seg)!.type}`"
                >
                  {{ typeLabel(hunkForSegment(seg)!.type) }}
                </span>
                <span class="hunk-confidence muted">
                  Confiance : {{ confidenceLabel(hunkForSegment(seg)!.confidence) }}
                </span>
              </div>
              <span
                v-if="hunkForSegment(seg) && isAutoResolvable(hunkForSegment(seg)!)"
                class="hunk-badge hunk-badge--auto"
                aria-label="Résolution automatique disponible"
              >
                Auto
              </span>
              <span
                v-else
                class="hunk-badge hunk-badge--manual"
                aria-label="Résolution manuelle requise"
              >
                Manuel
              </span>
            </div>

            <!-- ── Inline Edit Mode ─────────────────────── -->
            <div v-if="editingHunkIndex === seg.hunkIndex" class="hunk-edit">
              <div class="edit-header">
                <span class="edit-label">{{ t('merge.customEdit') }}</span>
                <span class="edit-hint muted">Modifiez le contenu puis validez</span>
              </div>
              <textarea
                class="edit-textarea mono"
                v-model="editContent"
                :aria-label="`Editer le conflit ${seg.hunkIndex}`"
                spellcheck="false"
                rows="8"
              ></textarea>
              <div class="edit-actions">
                <button
                  class="action-btn action-btn--validate"
                  @click="validateEditing(seg.hunkIndex!)"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  {{ t('common.confirm') }}
                </button>
                <button
                  class="action-btn"
                  @click="cancelEditing"
                >
                  {{ t('common.cancel') }}
                </button>
              </div>
            </div>

            <!-- ── Normal 3-way View ─────────────────────── -->
            <template v-else>
              <!-- Three-way panels -->
              <div class="hunk-panels">
                <!-- Ours panel -->
                <div class="hunk-panel hunk-panel--ours">
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--ours" aria-hidden="true"></span>
                    Ours (current)
                  </div>
                  <pre class="panel-code mono"><code v-html="highlightedHtml(seg.hunkIndex!, 'ours')"></code></pre>
                </div>

                <!-- Base panel (if diff3) -->
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

                <!-- Theirs panel -->
                <div class="hunk-panel hunk-panel--theirs">
                  <div class="panel-label">
                    <span class="panel-dot panel-dot--theirs" aria-hidden="true"></span>
                    Theirs (incoming)
                  </div>
                  <pre class="panel-code mono"><code v-html="highlightedHtml(seg.hunkIndex!, 'theirs')"></code></pre>
                </div>
              </div>

              <!-- Manual resolution actions -->
              <div class="hunk-actions" v-if="hunkForSegment(seg)">
                <span class="hunk-actions-label muted">Résoudre :</span>
                <button
                  class="action-btn action-btn--ours"
                  @click="emit('resolveHunk', file.path, seg.hunkIndex!, 'ours')"
                  title="Garder la version Ours (current)"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  {{ t('merge.keepOurs') }}
                </button>
                <button
                  class="action-btn action-btn--theirs"
                  @click="emit('resolveHunk', file.path, seg.hunkIndex!, 'theirs')"
                  title="Garder la version Theirs (incoming)"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  {{ t('merge.keepTheirs') }}
                </button>
                <button
                  class="action-btn action-btn--both"
                  @click="emit('resolveHunk', file.path, seg.hunkIndex!, 'both')"
                  title="Garder les deux (Ours puis Theirs)"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M1 4h10M1 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                  {{ t('merge.keepBoth') }}
                </button>
                <button
                  class="action-btn action-btn--both-reverse"
                  @click="emit('resolveHunk', file.path, seg.hunkIndex!, 'both-theirs-first')"
                  title="Garder les deux (Theirs puis Ours)"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M1 4h10M1 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                  Les deux (inversé)
                </button>
                <span class="action-separator" aria-hidden="true"></span>
                <button
                  class="action-btn action-btn--edit"
                  @click="startEditing(seg.hunkIndex!, hunkForSegment(seg)!)"
                  title="Editer manuellement le résultat"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M8.5 1.5l2 2-7 7H1.5V8.5l7-7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  {{ t('merge.customEdit') }}
                </button>
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
  font-size: 13px;
  font-weight: 600;
}

.editor-stats {
  font-size: 12px;
}

.btn--resolve {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  background: var(--color-accent);
  color: #fff;
  transition: background 0.15s;
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
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ─── Conflict Hunk ────────────────────────────────────── */

.conflict-hunk {
  margin: 2px 0;
  border-left: 3px solid var(--color-danger);
  background: rgba(239, 68, 68, 0.04);
}

.conflict-hunk--resolvable {
  border-left-color: var(--color-success);
  background: var(--color-resolved-bg);
}

.hunk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px;
  border-bottom: 1px solid var(--color-border);
}

.hunk-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hunk-type-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
}

.hunk-type--same_change { color: var(--color-success); }
.hunk-type--one_side_change { color: var(--color-success); }
.hunk-type--delete_no_change { color: var(--color-warning); }
.hunk-type--whitespace_only { color: var(--color-text-muted); }
.hunk-type--non_overlapping { color: var(--color-ours); }
.hunk-type--complex { color: var(--color-danger); }

.hunk-confidence {
  font-size: 11px;
}

.hunk-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 4px;
}

.hunk-badge--auto {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.hunk-badge--manual {
  background: rgba(239, 68, 68, 0.12);
  color: var(--color-danger);
}

/* ─── Three-way Panels ─────────────────────────────────── */

.hunk-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--color-border);
}

.hunk-panel--base ~ .hunk-panel--theirs {
  /* When base is present, use 3 columns */
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
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
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
  font-size: 12px;
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
  gap: 12px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--color-border);
}

.edit-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent);
}

.edit-hint {
  font-size: 11px;
}

.edit-textarea {
  width: 100%;
  min-height: 120px;
  padding: 12px 20px;
  background: var(--color-bg);
  color: var(--color-text);
  border: none;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  tab-size: 2;
}

.edit-textarea:focus {
  background: var(--color-bg-secondary);
  box-shadow: inset 0 0 0 2px var(--color-accent);
}

.edit-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: var(--color-bg-secondary);
}

.action-btn--validate {
  background: var(--color-success) !important;
  color: #fff !important;
  border-color: var(--color-success) !important;
}

.action-btn--validate:hover {
  opacity: 0.9;
}

.action-separator {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  margin: 0 4px;
}

.action-btn--edit:hover {
  background: rgba(168, 85, 247, 0.1);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* ─── Diff Highlighting ────────────────────────────────── */

.panel-code :deep(.diff-add) {
  background: rgba(34, 197, 94, 0.2);
  border-radius: 2px;
  padding: 0 1px;
}

.hunk-panel--ours .panel-code :deep(.diff-add) {
  background: rgba(96, 165, 250, 0.25);
}

.hunk-panel--theirs .panel-code :deep(.diff-add) {
  background: rgba(168, 85, 247, 0.25);
}

.panel-code :deep(.diff-del) {
  background: rgba(239, 68, 68, 0.2);
  border-radius: 2px;
  padding: 0 1px;
  text-decoration: line-through;
  opacity: 0.7;
}

/* ─── Hunk Actions ─────────────────────────────────────── */

.hunk-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-wrap: wrap;
}

.hunk-actions-label {
  font-size: 11px;
  font-weight: 500;
  margin-right: 4px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  cursor: pointer;
}

.action-btn:hover {
  border-color: var(--color-text-muted);
}

.action-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.action-btn--ours:hover {
  background: var(--color-ours-bg);
  border-color: var(--color-ours);
  color: var(--color-ours);
}

.action-btn--theirs:hover {
  background: var(--color-theirs-bg);
  border-color: var(--color-theirs);
  color: var(--color-theirs);
}

.action-btn--both:hover,
.action-btn--both-reverse:hover {
  background: rgba(168, 85, 247, 0.1);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* ─── Explanation ──────────────────────────────────────── */

.hunk-explanation {
  padding: 6px 20px 8px;
  font-size: 12px;
  font-style: italic;
  border-top: 1px solid var(--color-border);
}
</style>

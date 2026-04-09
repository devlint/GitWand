<script setup lang="ts">
import { computed } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { computeDagLayout, parseRefs, type DagLayout } from "../utils/dagLayout";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  commits: GitLogEntry[];
  selectedHash?: string | null;
  /** Current branch name for highlighting */
  currentBranch?: string;
}>();

const emit = defineEmits<{
  "select-commit": [hash: string];
}>();

// ─── DAG layout ──────────────────────────────────────
const layout = computed<DagLayout>(() => computeDagLayout(props.commits));

// ─── Rendering constants ─────────────────────────────
const ROW_H = 32;       // height per commit row
const LANE_W = 16;      // width per lane
const NODE_R = 4;       // node circle radius
const GRAPH_PAD = 12;   // left padding before first lane
const SVG_MIN_W = 60;   // minimum graph column width

const graphWidth = computed(() => {
  return Math.max(SVG_MIN_W, GRAPH_PAD + (layout.value.maxLane + 1) * LANE_W + GRAPH_PAD);
});

const totalHeight = computed(() => props.commits.length * ROW_H);

// ─── Lane colours ────────────────────────────────────
const LANE_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

// ─── SVG path helpers ────────────────────────────────
function cx(lane: number): number {
  return GRAPH_PAD + lane * LANE_W + LANE_W / 2;
}

function cy(index: number): number {
  return index * ROW_H + ROW_H / 2;
}

/** Build an SVG path for an edge */
function edgePath(e: { fromIndex: number; fromLane: number; toIndex: number; toLane: number }): string {
  const x1 = cx(e.fromLane);
  const y1 = cy(e.fromIndex);
  const x2 = cx(e.toLane);
  const y2 = cy(e.toIndex);

  if (x1 === x2) {
    // Straight vertical
    return `M${x1},${y1} L${x2},${y2}`;
  }
  // Curved: use bezier for lane changes
  const midY = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
}

// ─── Helpers ─────────────────────────────────────────
function formatDate(raw: string): string {
  try {
    const d = new Date(raw);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return t("date.minutesAgo", String(diffMin));
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return t("date.hoursAgo", String(diffH));
    const diffD = Math.floor(diffH / 24);
    if (diffD < 30) return t("date.daysAgo", String(diffD));
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch { return raw; }
}

function commitRefs(entry: GitLogEntry) {
  return parseRefs(entry.refs);
}
</script>

<template>
  <div class="cg" v-if="commits.length > 0">
    <div class="cg-scroll">
      <!-- SVG graph column -->
      <svg
        class="cg-svg"
        :width="graphWidth"
        :height="totalHeight"
        :viewBox="`0 0 ${graphWidth} ${totalHeight}`"
      >
        <!-- Edges first (behind nodes) -->
        <path
          v-for="(edge, eIdx) in layout.edges"
          :key="'e' + eIdx"
          :d="edgePath(edge)"
          :stroke="laneColor(edge.fromLane)"
          :stroke-width="edge.isMerge ? 1.2 : 1.6"
          :stroke-dasharray="edge.isMerge ? '3,3' : 'none'"
          fill="none"
          stroke-linecap="round"
        />
        <!-- Nodes -->
        <g
          v-for="node in layout.nodes"
          :key="'n' + node.index"
          class="cg-node"
          @click="emit('select-commit', node.hash)"
        >
          <!-- Merge commit: bigger open circle -->
          <circle
            v-if="node.parents.length > 1"
            :cx="cx(node.lane)"
            :cy="cy(node.index)"
            :r="NODE_R + 1"
            :stroke="laneColor(node.lane)"
            stroke-width="2"
            fill="var(--color-bg)"
          />
          <!-- Normal commit: filled circle -->
          <circle
            v-else
            :cx="cx(node.lane)"
            :cy="cy(node.index)"
            :r="NODE_R"
            :fill="laneColor(node.lane)"
          />
        </g>
      </svg>

      <!-- Commit info rows (absolutely positioned to align with SVG rows) -->
      <div class="cg-info" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(entry, idx) in commits"
          :key="entry.hashFull"
          class="cg-row"
          :class="{ 'cg-row--selected': entry.hashFull === selectedHash }"
          :style="{ top: idx * ROW_H + 'px', height: ROW_H + 'px' }"
          @click="emit('select-commit', entry.hashFull)"
        >
          <!-- Ref badges -->
          <span
            v-for="r in commitRefs(entry)"
            :key="r.name"
            class="cg-ref"
            :class="`cg-ref--${r.type}`"
          >{{ r.name }}</span>
          <!-- Message -->
          <span class="cg-msg">{{ entry.message }}</span>
          <!-- Author + date -->
          <span class="cg-meta muted">
            <span>{{ entry.author }}</span>
            <span class="cg-sep">&middot;</span>
            <span>{{ formatDate(entry.date) }}</span>
            <span class="cg-sep">&middot;</span>
            <span class="mono cg-hash">{{ entry.hash }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="cg-empty muted">
    {{ t('log.noCommit') }}
  </div>
</template>

<style scoped>
.cg {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.cg-scroll {
  flex: 1;
  overflow: auto;
  display: flex;
  position: relative;
}

.cg-svg {
  flex-shrink: 0;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--color-bg);
}

.cg-node {
  cursor: pointer;
}

.cg-info {
  flex: 1;
  position: relative;
  min-width: 0;
}

.cg-row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px 0 4px;
  cursor: pointer;
  font-size: 12px;
  border-bottom: 1px solid var(--color-border);
  transition: background 0.1s;
  overflow: hidden;
  white-space: nowrap;
}

.cg-row:hover {
  background: var(--color-bg-tertiary);
}

.cg-row--selected {
  background: var(--color-accent-bg, rgba(56, 132, 255, 0.08));
}

.cg-ref {
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 3px;
  flex-shrink: 0;
  line-height: 1.5;
}

.cg-ref--branch,
.cg-ref--head {
  background: var(--color-accent);
  color: #fff;
}

.cg-ref--remote {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}

.cg-ref--tag {
  background: #f59e0b;
  color: #fff;
}

.cg-msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
  color: var(--color-text);
}

.cg-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  flex-shrink: 0;
}

.cg-sep {
  opacity: 0.4;
}

.cg-hash {
  font-size: 10px;
  color: var(--color-accent);
}

.cg-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  font-size: 13px;
}
</style>

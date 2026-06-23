<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import {
  agentSessionList,
  agentSessionLaunch,
  type AgentSession,
} from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-tab", path: string): void;
  (e: "launch-agent", payload: { path: string; tool: string }): void;
}>();

const { t } = useI18n();

// ─── State ───────────────────────────────────────────────

const sessions = ref<AgentSession[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const launching = ref<string | null>(null); // path being launched

// ─── Helpers ─────────────────────────────────────────────

function toolLabel(tool: string): string {
  switch (tool) {
    case "claude":   return t("agents.toolClaude");
    case "cursor":   return t("agents.toolCursor");
    case "windsurf": return t("agents.toolWindsurf");
    default:         return t("agents.toolOther");
  }
}

function toolColor(tool: string): string {
  switch (tool) {
    case "claude":   return "ap-tool--claude";
    case "cursor":   return "ap-tool--cursor";
    case "windsurf": return "ap-tool--windsurf";
    default:         return "ap-tool--other";
  }
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? path : "…/" + parts.slice(-2).join("/");
}

// ─── Actions ─────────────────────────────────────────────

async function loadSessions() {
  loading.value = true;
  error.value = null;
  try {
    sessions.value = await agentSessionList(props.cwd);
  } catch (err: any) {
    error.value = t("agents.errorList").replace("{0}", String(err?.message ?? err));
  } finally {
    loading.value = false;
  }
}

async function launch(session: AgentSession) {
  launching.value = session.path;
  error.value = null;
  try {
    if (session.tool === "cursor" || session.tool === "windsurf") {
      // GUI editors: open externally via the existing command.
      await agentSessionLaunch(session.path, session.tool);
    } else {
      // claude / other: integrated PTY tab.
      emit("launch-agent", { path: session.path, tool: "claude" });
    }
    // Re-poll to reflect real state instead of a fake optimistic active flag.
    await loadSessions();
  } catch (err: any) {
    error.value = t("agents.errorLaunch").replace("{0}", String(err?.message ?? err));
  } finally {
    launching.value = null;
  }
}

// Sort: active first, then by path
const sortedSessions = computed(() =>
  [...sessions.value].sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return a.path.localeCompare(b.path);
  })
);

onMounted(loadSessions);
</script>

<template>
  <BaseModal
    :title="t('agents.title')"
    size="lg"
    scroll-own
    body-flush
    @close="emit('close')"
  >
    <!-- Title icon -->
    <template #title-icon>
      <div class="ap-modal-icon">
        <!-- Robot / agent icon -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M12 2v4M8 11V9a4 4 0 0 1 8 0v2" />
          <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none" />
          <path d="M9 20h6" />
        </svg>
      </div>
    </template>

    <!-- Header actions -->
    <template #header-actions>
      <button
        type="button"
        class="bm-btn bm-btn--ghost"
        :disabled="loading"
        @click="loadSessions"
      >
        {{ t("agents.reload") }}
      </button>
    </template>

    <!-- Body -->
    <div class="ap-body">
      <!-- Error -->
      <div v-if="error" class="ap-error">{{ error }}</div>

      <!-- Loading -->
      <div v-if="loading" class="ap-state">{{ t("common.loading") }}</div>

      <!-- Empty -->
      <div v-else-if="!loading && sessions.length === 0" class="ap-empty">
        <svg class="ap-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M12 2v4M8 11V9a4 4 0 0 1 8 0v2" />
          <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none" />
          <path d="M9 20h6" />
        </svg>
        <p class="ap-empty-text">{{ t("agents.empty") }}</p>
      </div>

      <!-- Session list -->
      <div v-else class="ap-list">
        <div
          v-for="session in sortedSessions"
          :key="session.path"
          class="ap-card"
          :class="{ 'ap-card--active': session.active }"
        >
          <!-- Left: tool badge + info -->
          <div class="ap-card-left">
            <div class="ap-tool-badge" :class="toolColor(session.tool)">
              <!-- Claude Code icon -->
              <svg v-if="session.tool === 'claude'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
              </svg>
              <!-- Cursor icon -->
              <svg v-else-if="session.tool === 'cursor'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M4 4l6 16 3-7 7-3L4 4z"/>
              </svg>
              <!-- Windsurf icon -->
              <svg v-else-if="session.tool === 'windsurf'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M3 17c3-6 8-13 18-13C15 10 14 17 9 17H3z"/>
              </svg>
              <!-- Generic MCP icon -->
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3"/>
              </svg>
            </div>

            <div class="ap-card-info">
              <div class="ap-card-title">
                <span class="ap-card-tool">{{ toolLabel(session.tool) }}</span>
                <span v-if="session.active" class="ap-badge ap-badge--active">
                  <span class="ap-pulse" />
                  {{ t("agents.active") }}
                </span>
                <span v-else class="ap-badge ap-badge--configured">
                  {{ t("agents.configured") }}
                </span>
              </div>

              <div class="ap-card-branch">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="5" cy="3" r="1.5" />
                  <circle cx="5" cy="13" r="1.5" />
                  <circle cx="11" cy="6" r="1.5" />
                  <path d="M5 4.5v7M5 4.5C5 7 11 7.5 11 6" />
                </svg>
                {{ session.branch || "HEAD" }}

                <!-- Status pills -->
                <span v-if="session.ahead > 0" class="ap-pill ap-pill--ahead">↑{{ session.ahead }}</span>
                <span v-if="session.behind > 0" class="ap-pill ap-pill--behind">↓{{ session.behind }}</span>
                <span v-if="session.modified > 0" class="ap-pill ap-pill--modified">~{{ session.modified }}</span>
              </div>

              <div class="ap-card-path" :title="session.path">{{ shortPath(session.path) }}</div>
            </div>
          </div>

          <!-- Right: actions -->
          <div class="ap-card-actions">
            <button
              class="bm-btn bm-btn--ghost ap-btn-sm"
              @click="emit('open-tab', session.path)"
            >
              {{ t("agents.openInTab") }}
            </button>
            <button
              v-if="session.tool === 'claude' || session.tool === 'other'"
              class="bm-btn bm-btn--primary ap-btn-sm"
              :disabled="launching === session.path"
              @click="launch(session)"
            >
              {{ launching === session.path ? t("agents.launching") : t("agents.launch") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
/* ── Modal icon ─────────────────────────────────────────── */
.ap-modal-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}

/* ── Body ───────────────────────────────────────────────── */
.ap-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Error ──────────────────────────────────────────────── */
.ap-error {
  margin: var(--space-4) var(--space-7) 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

/* ── States ─────────────────────────────────────────────── */
.ap-state {
  padding: var(--space-10) var(--space-7);
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  text-align: center;
}

.ap-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12) var(--space-10);
  gap: var(--space-5);
}

.ap-empty-icon {
  color: var(--color-text-muted);
  opacity: 0.4;
}

.ap-empty-text {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  text-align: center;
  max-width: 360px;
  line-height: 1.6;
}

/* ── List ───────────────────────────────────────────────── */
.ap-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-7) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* ── Card ───────────────────────────────────────────────── */
.ap-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.ap-card:hover {
  border-color: var(--color-accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.ap-card--active {
  border-color: rgba(72, 187, 120, 0.4);
  background: rgba(72, 187, 120, 0.03);
}

.ap-card-left {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  min-width: 0;
}

.ap-card-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ap-card-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.ap-card-tool {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.ap-card-branch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  flex-wrap: wrap;
}

.ap-card-path {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ap-card-actions {
  display: flex;
  gap: var(--space-3);
  flex-shrink: 0;
}

.ap-btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

/* ── Tool badge ─────────────────────────────────────────── */
.ap-tool-badge {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ap-tool--claude   { background: rgba(212, 168, 100, 0.15); color: #d4a864; }
.ap-tool--cursor   { background: rgba(99, 102, 241, 0.15);  color: #6366f1; }
.ap-tool--windsurf { background: rgba(34, 197, 94, 0.15);   color: #22c55e; }
.ap-tool--other    { background: var(--color-accent-soft);  color: var(--color-accent); }

/* ── Status badge ───────────────────────────────────────── */
.ap-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  padding: 2px 6px;
  border-radius: var(--radius-pill);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ap-badge--active {
  background: rgba(72, 187, 120, 0.15);
  color: #48bb78;
}

.ap-badge--configured {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

/* Pulse dot for active sessions */
.ap-pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #48bb78;
  animation: ap-pulse 1.8s ease-in-out infinite;
}

@keyframes ap-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.5; transform: scale(0.8); }
}

/* ── Status pills ───────────────────────────────────────── */
.ap-pill {
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  padding: 1px 5px;
  border-radius: var(--radius-pill);
}

.ap-pill--ahead    { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
.ap-pill--behind   { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
.ap-pill--modified { background: rgba(236, 72, 153, 0.15); color: #ec4899; }
</style>

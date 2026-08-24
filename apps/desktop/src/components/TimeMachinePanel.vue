<script setup lang="ts">
import { computed, ref, onMounted, watch, inject } from "vue";
import BaseModal from "./BaseModal.vue";
import { useTimeMachine, type TimelineItem } from "../composables/useTimeMachine";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import { formatRelativeAge } from "../utils/relativeTime";

/**
 * Time Machine (v3.8) — the full chronological history of the repo, merging
 * GitWand snapshots and git's reflog, each point restorable in one click.
 *
 * The quick path is the rewind popover in AppHeader (⌘⇧U); this modal is what
 * its footer link opens when the user wants the whole picture.
 */

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "restored"): void;
}>();

const { t } = useI18n();
const { settings } = useSettings();
const tm = useTimeMachine();

const askConfirm = inject<(options: any) => Promise<boolean>>("askConfirm");

type Filter = "all" | "snapshot" | "reflog";
const filter = ref<Filter>("all");
const busyKey = ref<string | null>(null);

const items = computed(() =>
  tm.timeline.value.filter((i) => filter.value === "all" || i.source === filter.value),
);

/**
 * Primary line. Snapshot labels are stored English (they are the snapshot
 * commit's message, see `git/snapshot.rs`), so the localized `kind` is what
 * the user reads; git's own reflog subject is shown as-is, like `git reflog`.
 */
function primary(item: TimelineItem): string {
  if (item.source === "reflog") return item.label;
  const map: Record<string, string> = {
    manual: t("timeMachine.kindManual"),
    discard: t("timeMachine.kindDiscard"),
    reset: t("timeMachine.kindReset"),
    checkout: t("timeMachine.kindCheckout"),
    resolution: t("timeMachine.kindResolution"),
  };
  return map[item.kind] ?? item.kind;
}

/** Second line: what this point actually restores. */
function detail(item: TimelineItem): string {
  if (item.source === "reflog") return t("timeMachine.detailRefMove");
  const branch = item.snapshot?.headRef ?? "HEAD";
  const what = item.snapshot?.mergeHead
    ? t("timeMachine.detailConflicts")
    : t("timeMachine.detailWorktree");
  return `${item.label} · ${branch} · ${what}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function age(ms: number): string {
  return formatRelativeAge(new Date(ms).toISOString(), t);
}

async function onRestore(item: TimelineItem) {
  // House rule: the in-app modal confirm, never native confirm().
  if (askConfirm) {
    const ok = await askConfirm({
      title: t("timeMachine.restoreTitle"),
      message: t("timeMachine.restoreConfirm"),
      confirmLabel: t("timeMachine.restoreButton"),
    });
    if (!ok) return;
  }
  busyKey.value = item.key;
  try {
    await tm.restore(props.cwd, item);
    emit("restored");
  } catch {
    // lastError is set by the composable and rendered below.
  } finally {
    busyKey.value = null;
  }
}

onMounted(() => tm.refresh(props.cwd));
watch(
  () => props.cwd,
  (next) => {
    if (next) tm.refresh(next);
  },
);
</script>

<template>
  <BaseModal
    size="lg"
    :title="t('timeMachine.title')"
    :subtitle="t('timeMachine.subtitle')"
    @close="emit('close')"
  >
    <template #title-icon>
      <span class="bm-title-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="13" r="8" stroke="currentColor" stroke-width="1.6" />
          <path d="M12 9.5V13l2.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M4 5v4h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M4 9a8 8 0 018-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </span>
    </template>

    <div class="tm-filters">
      <button class="tm-filter" :class="{ 'tm-filter--on': filter === 'all' }" @click="filter = 'all'">
        {{ t('timeMachine.filterAll') }}
      </button>
      <button class="tm-filter" :class="{ 'tm-filter--on': filter === 'snapshot' }" @click="filter = 'snapshot'">
        {{ t('timeMachine.filterSnapshots') }}
      </button>
      <button class="tm-filter" :class="{ 'tm-filter--on': filter === 'reflog' }" @click="filter = 'reflog'">
        {{ t('timeMachine.filterGit') }}
      </button>
      <span class="tm-spacer"></span>
      <span class="tm-retention muted">
        {{ t('timeMachine.retentionSummary', tm.timeline.value.length, settings.snapshotRetentionDays ?? 14) }}
      </span>
    </div>

    <p v-if="tm.lastError.value" class="tm-error">{{ tm.lastError.value }}</p>
    <p v-else-if="items.length === 0 && !tm.isLoading.value" class="tm-empty muted">
      {{ t('timeMachine.empty') }}
    </p>

    <ol v-else class="tm-list">
      <li v-for="item in items" :key="item.key" class="tm-item">
        <span class="tm-clock mono muted" :title="age(item.timestampMs)">{{ clock(item.timestampMs) }}</span>
        <span class="tm-source" :class="{ 'tm-source--snapshot': item.source === 'snapshot' }">
          {{ item.source === 'snapshot' ? t('timeMachine.sourceSnapshot') : t('timeMachine.sourceReflog') }}
        </span>
        <div class="tm-body">
          <div class="tm-label">{{ primary(item) }}</div>
          <div class="tm-detail muted">{{ detail(item) }}</div>
        </div>
        <button
          v-if="item.restorable"
          class="tm-restore"
          :disabled="busyKey === item.key"
          @click="onRestore(item)"
        >
          {{ t('timeMachine.restore') }}
        </button>
      </li>
    </ol>
  </BaseModal>
</template>

<style scoped>
.tm-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 var(--space-3);
  border-bottom: 1px solid var(--color-border);
}
.tm-filter {
  font-size: 12px;
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
}
.tm-filter--on {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.tm-spacer { flex: 1; }
.tm-retention { font-size: 12px; }
.tm-error { color: var(--color-danger); font-size: 12px; padding: var(--space-3) 0; }
.tm-empty { font-size: 13px; padding: var(--space-4) 0; }
.tm-list { list-style: none; margin: 0; padding: var(--space-2) 0 0; }
.tm-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
}
.tm-item:hover { background: var(--color-bg-hover); }
/* Source badge, matching the rewind popover's `.undo-entry-type` idiom
   rather than a coloured rail. */
.tm-source {
  font-size: 11px;
  flex-shrink: 0;
  width: 68px;
  padding-top: 2px;
  color: var(--color-text-subtle);
}
.tm-source--snapshot { color: var(--color-accent); }
.tm-clock { font-size: 11px; width: 44px; flex-shrink: 0; padding-top: 2px; }
.tm-body { flex: 1; min-width: 0; }
.tm-label { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tm-detail {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-restore { font-size: 12px; padding: 2px 10px; }
</style>

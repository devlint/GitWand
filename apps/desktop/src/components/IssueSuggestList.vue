<script setup lang="ts">
/**
 * The open issues offered under `#` in a commit field (#301, part 4).
 * Rows are picked on mousedown (prevented) so the field keeps its focus.
 */
import type { Issue } from "../utils/backend";
import type { SuggestStatus } from "../composables/useIssueSuggest";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{ status: SuggestStatus; rows: Issue[]; active: number; listId?: string }>();
const emit = defineEmits<{ pick: [index: number, fixes: boolean] }>();
const { t } = useI18n();
</script>

<template>
  <div :id="props.listId" class="isl" role="listbox" @mousedown.prevent>
    <div
      v-for="(issue, i) in rows"
      :key="issue.number + issue.url"
      :id="props.listId ? `${props.listId}-${i}` : undefined"
      class="isl-row"
      :class="{ 'isl-row--active': i === active }"
      role="option"
      :aria-selected="i === active"
      @mousedown.prevent="emit('pick', i, $event.shiftKey)"
    >
      <span class="isl-num mono">#{{ issue.number }}</span>
      <span class="isl-title">{{ issue.title }}</span>
    </div>
    <p v-if="rows.length === 0 && status === 'loading'" class="isl-note">{{ t("sidebar.issueSuggest.loading") }}</p>
    <p v-else-if="rows.length === 0 && status === 'error'" class="isl-note">{{ t("sidebar.issueSuggest.unavailable") }}</p>
    <p v-else-if="rows.length === 0" class="isl-note">{{ t("sidebar.issueSuggest.empty") }}</p>
    <p class="isl-hint mono">{{ t("sidebar.issueSuggest.hint") }}</p>
  </div>
</template>

<style scoped>
.isl {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 200;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}
.isl-row {
  display: flex;
  gap: var(--space-3);
  align-items: baseline;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--font-size-sm);
  min-width: 0;
}
.isl-row:hover,
.isl-row--active {
  background: var(--color-bg-tertiary, var(--color-bg));
}
.isl-num {
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.isl-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.isl-note {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.isl-hint {
  margin: 0;
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--color-border);
  font-size: var(--font-size-xs, 11px);
  color: var(--color-text-muted);
}
</style>

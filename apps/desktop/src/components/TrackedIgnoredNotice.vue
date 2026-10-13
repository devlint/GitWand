<script setup lang="ts">
/**
 * TrackedIgnoredNotice — discreet notice in the Changes pane when tracked
 * files match an ignore rule. Opens a list; from it the user untracks all or a
 * selection after an explicit confirmation (files stay on disk, removal is
 * staged). State and git calls live in useTrackedIgnored.
 */
import { computed, ref, watch } from "vue";
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import { useTrackedIgnored } from "../composables/useTrackedIgnored";

const emit = defineEmits<{ refresh: [] }>();
const { t } = useI18n();
const { info, visible, untracking, error, dismiss, untrack } = useTrackedIgnored();

const showList = ref(false);
/** Paths awaiting confirmation, or null when the confirm step is closed. */
const pending = ref<string[] | null>(null);
const selected = ref<Set<string>>(new Set());

const paths = computed(() => info.value?.paths ?? []);
const total = computed(() => info.value?.total ?? 0);
const allSelected = computed(() => paths.value.length > 0 && selected.value.size === paths.value.length);

const noticeText = computed(() =>
  total.value === 1 ? t("trackedIgnored.noticeOne") : t("trackedIgnored.noticeMany", total.value),
);

// A re-check can shrink the list under an open dialog: drop stale selections,
// and close everything once nothing is left.
watch(paths, (now) => {
  const keep = new Set(now);
  selected.value = new Set([...selected.value].filter((p) => keep.has(p)));
  if (now.length === 0) {
    showList.value = false;
    pending.value = null;
  }
});

function openList() {
  selected.value = new Set();
  showList.value = true;
}

function toggle(path: string) {
  const next = new Set(selected.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(paths.value);
}

function ask(list: string[]) {
  if (list.length > 0) pending.value = list;
}

async function confirmUntrack() {
  const list = pending.value;
  if (!list) return;
  const ok = await untrack(list);
  pending.value = null;
  if (ok) emit("refresh");
}
</script>

<template>
  <div v-if="visible" class="tin" role="note">
    <svg class="tin__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      stroke-width="1.4" aria-hidden="true">
      <path d="M8 2l6.5 11.5h-13z" stroke-linejoin="round" />
      <path d="M8 6.5v3M8 11.5v.01" stroke-linecap="round" />
    </svg>
    <span class="tin__text">{{ noticeText }}</span>
    <button type="button" class="tin__btn" @click="openList">{{ t('trackedIgnored.review') }}</button>
    <button type="button" class="tin__btn tin__btn--quiet" @click="dismiss">{{ t('trackedIgnored.dismiss') }}</button>
  </div>

  <BaseModal v-if="showList" :title="t('trackedIgnored.title')" size="xl" @close="showList = false">
    <p class="tin-intro">{{ t('trackedIgnored.intro') }}</p>
    <div class="tin-toolbar">
      <label class="tin-check">
        <input type="checkbox" :checked="allSelected" @change="toggleAll" />
        {{ t('trackedIgnored.selectAll') }}
      </label>
      <span class="tin-count">{{ t('trackedIgnored.selectedCount', selected.size) }}</span>
    </div>
    <ul class="tin-list">
      <li v-for="p in paths" :key="p">
        <label class="tin-check tin-check--path">
          <input type="checkbox" :checked="selected.has(p)" @change="toggle(p)" />
          <span class="tin-path">{{ p }}</span>
        </label>
      </li>
    </ul>
    <p v-if="info?.truncated" class="tin-intro">{{ t('trackedIgnored.shown', paths.length, total) }}</p>
    <p v-if="error" class="tin-error" role="alert">{{ t('trackedIgnored.failed', error) }}</p>
    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost" :disabled="untracking || selected.size === 0"
        @click="ask([...selected])">
        {{ t('trackedIgnored.untrackSelected') }}
      </button>
      <button type="button" class="bm-btn bm-btn--primary" :disabled="untracking || paths.length === 0"
        @click="ask([...paths])">
        {{ t('trackedIgnored.untrackAll') }}
      </button>
    </template>
  </BaseModal>

  <BaseModal v-if="pending" :title="t('trackedIgnored.confirmTitle')" size="sm" role="alertdialog"
    @close="pending = null">
    <p class="tin-intro">{{ t('trackedIgnored.confirmBody', pending.length) }}</p>
    <p v-if="info?.truncated && pending.length === paths.length" class="tin-intro">
      {{ t('trackedIgnored.confirmBodyTruncated', pending.length) }}
    </p>
    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost" @click="pending = null">{{ t('common.cancel') }}</button>
      <button type="button" class="bm-btn bm-btn--primary" :disabled="untracking" @click="confirmUntrack">
        {{ t('trackedIgnored.confirm') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.tin {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  margin: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.tin__icon {
  flex-shrink: 0;
}

.tin__text {
  flex: 1;
  min-width: 10em;
}

.tin__btn {
  padding: 1px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
}

.tin__btn--quiet {
  border-color: transparent;
  background: transparent;
  color: var(--color-text-muted);
}

.tin__btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.tin__btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.tin-intro {
  margin: 0 0 var(--space-3);
  line-height: 1.5;
  color: var(--color-text-muted);
}

.tin-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: var(--font-size-sm);
}

.tin-count {
  color: var(--color-text-muted);
}

.tin-check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}

.tin-list {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
}

.tin-check--path {
  display: flex;
  padding: 1px 0;
}

.tin-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tin-error {
  margin: 0;
  color: var(--color-danger, #d1242f);
}
</style>

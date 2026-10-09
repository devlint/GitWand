<script setup lang="ts">
/**
 * RemoteImagesNotice — shown above rendered markdown whose remote images were
 * withheld (see `useSafeHtml`). One button accepts them: for the PR being
 * read, or — with `perProject` — for every README render of this project.
 */
import { useI18n } from "../composables/useI18n";

defineProps<{
  /** The choice is remembered for the project (README) rather than this view. */
  perProject?: boolean;
}>();
const emit = defineEmits<{ allow: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="rin" role="note">
    <svg class="rin__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      stroke-width="1.3" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
    </svg>
    <span class="rin__text">{{ t('common.remoteImagesHidden') }}</span>
    <button type="button" class="rin__btn" @click="emit('allow')">
      {{ perProject ? t('common.remoteImagesShowForProject') : t('common.remoteImagesShow') }}
    </button>
  </div>
</template>

<style scoped>
.rin {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.rin__icon {
  flex-shrink: 0;
}

.rin__text {
  flex: 1;
  min-width: 12em;
}

.rin__btn {
  padding: 2px var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
}

.rin__btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.rin__btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
</style>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n";

defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  openSearch: [];
}>();

const { t } = useI18n();

const shortcutLabel = ref("Ctrl+K");

function onMouseDown(ev: MouseEvent) {
  ev.preventDefault();
  emit("openSearch");
}

function onKeydown(ev: KeyboardEvent) {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const modPressed = isMac ? ev.metaKey : ev.ctrlKey;
  if (!modPressed) return;
  if (ev.key !== "k" && ev.key !== "K") return;
  ev.preventDefault();
  emit("openSearch");
}

onMounted(() => {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  shortcutLabel.value = isMac ? "⌘K" : "Ctrl+K";
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <button
    class="search-btn"
    :class="{ 'search-btn--disabled': disabled }"
    :aria-label="t('header.searchAriaLabel')"
    :title="t('header.searchAriaLabel')"
    :disabled="disabled"
    @mousedown="onMouseDown"
  >
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
    <kbd class="search-btn__kbd" aria-hidden="true">{{ shortcutLabel }}</kbd>
  </button>
</template>

<style scoped>
.search-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  height: 32px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  border: 1px solid transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-base), color var(--transition-base), border-color var(--transition-base);
  white-space: nowrap;
  flex-shrink: 0;
}

.search-btn:hover:not(:disabled) {
  background: var(--color-border);
  color: var(--color-text);
}

.search-btn:focus-visible {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.search-btn--disabled,
.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.search-btn__kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm, 4px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  letter-spacing: 0.02em;
  box-shadow: 0 1px 0 var(--color-border);
}
</style>

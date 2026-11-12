<script setup lang="ts">
import { useI18n } from "../composables/useI18n";
import { useAdventCard } from "../composables/useAdventCard";

const { t } = useI18n();
const { card, dismiss, open } = useAdventCard();
</script>

<template>
  <aside v-if="card" class="advent-card" :aria-label="t('dashboard.advent.eyebrow')">
    <span class="advent-card__tree" aria-hidden="true">🎄</span>
    <div class="advent-card__body">
      <div class="advent-card__title">
        {{ t("dashboard.advent.eyebrow") }}
        <span class="advent-card__sep" aria-hidden="true">·</span>
        <span class="advent-card__state">
          {{ card.kind === "door" ? t("dashboard.advent.doorOpen", card.day) : t("dashboard.advent.allOpen", card.count) }}
        </span>
      </div>
      <!-- Door content is English on every surface (CLI, website, app). -->
      <div v-if="card.kind === 'door'" class="advent-card__door" lang="en">
        <code class="advent-card__cmd">{{ card.command }}</code>
        <span class="advent-card__problem">{{ card.problem }}</span>
      </div>
      <div v-else class="advent-card__door">
        <span class="advent-card__problem">{{ t("dashboard.advent.allOpenBody") }}</span>
      </div>
    </div>
    <button type="button" class="btn btn--primary advent-card__open" @click="open">
      {{ card.kind === "door" ? t("dashboard.advent.open", card.day) : t("dashboard.advent.browse") }}
    </button>
    <button
      type="button"
      class="advent-card__dismiss"
      :title="t('dashboard.advent.dismiss')"
      :aria-label="t('dashboard.advent.dismiss')"
      @click="dismiss"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>
  </aside>
</template>

<style scoped>
.advent-card {
  /* Always first, even with the "README first" layout (which uses order: -1). */
  order: -2;
  display: flex;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-4) var(--space-5);
  background: var(--color-bg-secondary);
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  border-radius: var(--radius-xl);
}
.advent-card__tree { font-size: 22px; line-height: 1; flex-shrink: 0; }
.advent-card__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.advent-card__title { font-size: var(--font-size-md); font-weight: 600; }
.advent-card__sep { margin: 0 var(--space-2); color: var(--color-text-muted); }
.advent-card__state { color: var(--color-accent); }
.advent-card__door {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.advent-card__cmd {
  flex-shrink: 0;
  font-family: var(--font-mono);
  color: var(--color-text);
}
.advent-card__problem { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.advent-card__open { flex-shrink: 0; }
.advent-card__dismiss {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: transparent;
}
.advent-card__dismiss:hover { color: var(--color-text); background: var(--color-bg-tertiary); }
</style>

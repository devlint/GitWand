<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useFolderHistory } from "../composables/useFolderHistory";
import { useI18n } from "../composables/useI18n";
import { locales, type SupportedLocale } from "../locales";
import AiSparkle from "./AiSparkle.vue";

const emit = defineEmits<{
  openFolder: [];
  openPath: [path: string];
  openClone: [];
  openFork: [];
}>();

const { history } = useFolderHistory();
const { t, locale } = useI18n();

const recentFolders = computed(() => history.value.slice(0, 5));

const isMac = navigator.platform.toUpperCase().includes("MAC");

/** Version injected at build time by vite.config.ts */
const appVersion = __APP_VERSION__;

// ─── Rotating tips (Phase 1.3.5) ──────────────────────
const TIP_ROTATION_MS = 30_000;

const tips = computed<readonly string[]>(() => {
  const l = locale.value as SupportedLocale;
  return locales[l]?.empty?.tips ?? locales.fr.empty.tips;
});

/**
 * Start at a random index each mount so consecutive app opens don't
 * always land on the same tip. Rotate sequentially from there so the
 * user doesn't see a tip twice in a short window.
 */
const tipIndex = ref(
  tips.value.length > 0 ? Math.floor(Math.random() * tips.value.length) : 0,
);

const currentTip = computed(() => tips.value[tipIndex.value % tips.value.length] ?? "");

let rotationTimer: ReturnType<typeof setInterval> | null = null;

function advanceTip() {
  if (tips.value.length === 0) return;
  tipIndex.value = (tipIndex.value + 1) % tips.value.length;
}

onMounted(() => {
  rotationTimer = setInterval(advanceTip, TIP_ROTATION_MS);
});

onUnmounted(() => {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
});
</script>

<template>
  <div class="empty-state" role="status">
    <div class="empty-visual" aria-hidden="true">
      <!-- Full GitWand logo: cube + code icon left + git graph right -->
      <!-- Colors driven by CSS custom properties so they adapt to theming -->
      <img src="/logo.png" alt="GitWand" width="200" class="logo-img">
    </div>

    <h2 class="empty-title">{{ t('empty.title') }}</h2>
    <p class="empty-desc muted">{{ t('empty.subtitle') }}</p>

    <button
      class="empty-btn"
      @click="emit('openFolder')"
      :aria-label="t('empty.openButton')"
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      </svg>
      {{ t('empty.openButton') }}
    </button>

    <!-- Secondary actions: Clone / Fork (v2.0) -->
    <div class="empty-secondary-row">
      <button
        type="button"
        class="empty-btn-secondary"
        @click="emit('openClone')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ t('empty.cloneButton') }}
      </button>
      <button
        type="button"
        class="empty-btn-secondary"
        @click="emit('openFork')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="6" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <circle cx="18" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <circle cx="12" cy="19" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <path d="M6 7.2v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <path d="M12 13.2v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        {{ t('empty.forkButton') }}
      </button>
    </div>

    <!-- Rotating feature tip -->
    <div v-if="currentTip" class="empty-tip" role="note" aria-live="polite">
      <span class="empty-tip-label">
        <AiSparkle :size="12" />
        {{ t('empty.tipLabel') }}
      </span>
      <Transition name="tip-fade" mode="out-in">
        <p :key="tipIndex" class="empty-tip-text">{{ currentTip }}</p>
      </Transition>
    </div>

    <!-- Recent repos -->
    <div v-if="recentFolders.length > 0" class="recent-section">
      <span class="recent-label muted">{{ t('empty.recentTitle') }}</span>
      <div class="recent-cards">
        <button
          v-for="entry in recentFolders"
          :key="entry.path"
          class="recent-card"
          @click="emit('openPath', entry.path)"
          :title="entry.path"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
            <path d="M5 6v4M7 4h3c1.1 0 2 .9 2 2v0" stroke="currentColor" stroke-width="1.3"/>
          </svg>
          <span class="recent-card-name">{{ entry.name }}</span>
        </button>
      </div>
    </div>

    <div class="empty-hint muted">
      <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd> + <kbd>K</kbd> {{ t('empty.shortcut') }}
    </div>

    <!-- App version — subtle, bottom-right corner -->
    <span class="app-version subtle" aria-label="Version de l'application">v{{ appVersion }}</span>
  </div>
</template>

<style scoped>
.empty-state {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: var(--space-6);
  padding: var(--space-10);
  text-align: center;
}

.empty-visual {
  margin-bottom: var(--space-4);
  animation: float 4s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50%     { transform: translateY(-6px); }
}

.empty-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
}

.empty-desc {
  font-size: var(--font-size-lg);
  line-height: var(--line-height-normal);
  max-width: 360px;
}

.empty-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-8);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  background: var(--color-accent);
  color: var(--color-accent-text);
  transition: background var(--transition-base), transform var(--transition-fast), box-shadow var(--transition-base);
  margin-top: var(--space-4);
  box-shadow: var(--shadow-sm);
}

.empty-btn:hover {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.empty-btn:active { transform: translateY(0); box-shadow: var(--shadow-xs); }

/* ─── Secondary actions row (Clone / Fork) ───────────── */

.empty-secondary-row {
  display: flex;
  gap: var(--space-3);
  margin-top: calc(var(--space-2) * -1); /* tighten under the primary button */
}

.empty-btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: border-color var(--transition-base), background var(--transition-base), color var(--transition-base), transform var(--transition-fast);
}

.empty-btn-secondary:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  transform: translateY(-1px);
}

.empty-btn-secondary:active { transform: translateY(0); }

.empty-btn-secondary svg { color: currentColor; }

/* ─── Rotating tip ───────────────────────────────────── */

.empty-tip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: 520px;
  margin-top: var(--space-4);
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.08));
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
}

.empty-tip-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-ai);
}

.empty-tip-text {
  margin: 0;
  font-size: var(--font-size-md);
  line-height: var(--line-height-normal);
  color: var(--color-text);
}

.tip-fade-enter-active,
.tip-fade-leave-active {
  transition: opacity 400ms ease, transform 400ms ease;
}

.tip-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.tip-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ─── Recent repos ───────────────────────────────────── */

.recent-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  margin-top: var(--space-6);
}

.recent-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.recent-cards {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  justify-content: center;
  max-width: 560px;
}

.recent-card {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: border-color var(--transition-base), background var(--transition-base), box-shadow var(--transition-base), transform var(--transition-fast);
}

.recent-card:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  box-shadow: var(--shadow-xs);
  transform: translateY(-1px);
}

.recent-card svg {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.recent-card:hover svg { color: var(--color-accent); }
.recent-card:hover .recent-card-name { color: var(--color-accent); }

.recent-card-name { white-space: nowrap; }

/* ─── Hint ────────────────────────────────────────────── */

.empty-hint {
  font-size: var(--font-size-base);
  margin-top: var(--space-4);
}

.empty-hint kbd {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

/* ─── Version badge ──────────────────────────────────── */
.app-version {
  position: absolute;
  bottom: var(--space-5);
  right: var(--space-6);
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  user-select: none;
  pointer-events: none;
}
</style>

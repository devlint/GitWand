<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "../composables/useI18n";

type ModalSize = "sm" | "md" | "lg" | "xl" | "full";
type ModalPosition = "center" | "top";

const props = withDefaults(
  defineProps<{
    /** Main title displayed in the header. Leave empty to hide the built-in title (use #header slot instead). */
    title?: string;
    /** Optional subtitle / secondary text shown next to or below the title (e.g. commit hash). */
    subtitle?: string;
    /** Panel max-width preset. sm=400, md=520, lg=640, xl=960, full=90vw. */
    size?: ModalSize;
    /** Vertical alignment. "top" keeps the panel pinned toward the top (command palette style). */
    position?: ModalPosition;
    /** If false, clicking the backdrop or pressing Escape will NOT emit close. */
    closable?: boolean;
    /** ARIA role — usually "dialog", use "alertdialog" for destructive confirmations. */
    role?: "dialog" | "alertdialog";
    /** Optional aria-label when no visible title is present. */
    ariaLabel?: string;
    /** Hide the built-in header (title + close). Use when the component supplies a fully custom header via #header. */
    hideHeader?: boolean;
    /** Hide the default close button (Esc / backdrop still close unless closable=false). */
    hideClose?: boolean;
    /** Stretch body area to fill panel (no padding). Useful for full-bleed content like diff tables. */
    bodyFlush?: boolean;
    /** If true, the body is not scrollable; child content owns its own scrolling. */
    scrollOwn?: boolean;
  }>(),
  {
    title: "",
    subtitle: "",
    size: "md",
    position: "center",
    closable: true,
    role: "dialog",
    ariaLabel: "",
    hideHeader: false,
    hideClose: false,
    bodyFlush: false,
    scrollOwn: false,
  }
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { t } = useI18n();

const sizeClass = computed(() => `base-modal--${props.size}`);
const positionClass = computed(() => `base-modal-overlay--${props.position}`);

function requestClose() {
  if (!props.closable) return;
  emit("close");
}

function onBackdropClick() {
  requestClose();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    requestClose();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <div
      class="base-modal-overlay"
      :class="positionClass"
      @click.self="onBackdropClick"
    >
      <div
        class="base-modal"
        :class="sizeClass"
        :role="role"
        aria-modal="true"
        :aria-label="ariaLabel || title || undefined"
      >
        <!-- Header -->
        <header v-if="!hideHeader" class="base-modal__header">
          <slot name="header">
            <div class="base-modal__titleblock">
              <slot name="title-icon" />
              <div class="base-modal__titles">
                <h2 v-if="title" class="base-modal__title">{{ title }}</h2>
                <p v-if="subtitle" class="base-modal__subtitle">{{ subtitle }}</p>
              </div>
            </div>
          </slot>
          <slot name="header-actions" />
          <button
            v-if="!hideClose"
            class="base-modal__close"
            type="button"
            @click="requestClose"
            :aria-label="t('common.close')"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
            </svg>
          </button>
        </header>

        <!-- Optional toolbar slot between header and body -->
        <div v-if="$slots.toolbar" class="base-modal__toolbar">
          <slot name="toolbar" />
        </div>

        <!-- Body -->
        <div
          class="base-modal__body"
          :class="{
            'base-modal__body--flush': bodyFlush,
            'base-modal__body--scroll-own': scrollOwn,
          }"
        >
          <slot />
        </div>

        <!-- Footer -->
        <footer v-if="$slots.footer" class="base-modal__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ─── Overlay ───────────────────────────────────────── */
.base-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--color-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  animation: bm-fade-in var(--transition-base) ease;
}

.base-modal-overlay--center { align-items: center; }
.base-modal-overlay--top {
  align-items: flex-start;
  padding-top: 12vh;
}

@keyframes bm-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* ─── Panel ────────────────────────────────────────── */
.base-modal {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-xl);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: bm-slide-in var(--transition-slow) ease;
}

.base-modal--sm   { width: min(400px, 92vw); }
.base-modal--md   { width: min(520px, 92vw); }
.base-modal--lg   { width: min(640px, 92vw); }
.base-modal--xl   { width: min(960px, 94vw); max-height: 92vh; }
.base-modal--full { width: min(1200px, 94vw); max-height: 92vh; }

@keyframes bm-slide-in {
  from { opacity: 0; transform: translateY(-10px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ─── Header ───────────────────────────────────────── */
.base-modal__header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-6) var(--space-7) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.base-modal__titleblock {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.base-modal__titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.base-modal__title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
  color: var(--color-text);
  line-height: 1.25;
}

.base-modal__subtitle {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: 1.35;
}

.base-modal__close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.base-modal__close:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}
.base-modal__close:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

/* ─── Toolbar (optional strip between header and body) ─ */
.base-modal__toolbar {
  padding: var(--space-4) var(--space-7);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

/* ─── Body ─────────────────────────────────────────── */
.base-modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-7);
}

.base-modal__body--flush { padding: 0; }

/* scroll-own: body relinquishes its own scroll and becomes a
   vertical flex container so children can claim the remaining space
   with `flex: 1` and stick to edges with `flex-shrink: 0`. Typical use
   is a scrollable region + a sticky legend/footer strip. */
.base-modal__body--scroll-own {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ─── Footer ───────────────────────────────────────── */
.base-modal__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-7);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
}
</style>

<!-- Non-scoped helpers: canonical button styles usable from modal footer slots
     and title-icon slots (slot content can't reliably receive scoped attributes).
     Kept at (0,1,0) specificity so modifier classes can win without !important. -->
<style>
/* ── Title icon pill ── */
.bm-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft, rgba(124, 58, 237, 0.14));
  color: var(--color-accent);
  flex-shrink: 0;
}

.bm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  line-height: 1;
  cursor: pointer;
  background: transparent;
  color: var(--color-text);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.bm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.bm-btn--ghost {
  color: var(--color-text-muted);
  border-color: var(--color-border);
}
.bm-btn--ghost:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.bm-btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08), 0 4px 10px rgba(124, 58, 237, 0.22);
}
.bm-btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.08), 0 8px 16px rgba(124, 58, 237, 0.28);
}
.bm-btn--primary:active:not(:disabled) {
  transform: translateY(0);
}

.bm-btn--danger {
  background: var(--color-danger);
  color: #ffffff;
  border-color: var(--color-danger);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08), 0 4px 10px rgba(220, 38, 38, 0.22);
}
.bm-btn--danger:hover:not(:disabled) {
  filter: brightness(1.05);
  transform: translateY(-1px);
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.08), 0 8px 16px rgba(220, 38, 38, 0.28);
}
.bm-btn--danger:active:not(:disabled) {
  transform: translateY(0);
}

/* Disabled override for primary/danger — opacity: 0.5 alone reads weakly
   on saturated backgrounds (especially in light mode the violet stays
   very legible). Replace with a fully neutral state: muted bg + muted
   text + no shadow. opacity: 1 to override the parent .bm-btn:disabled.
   Specificity is (0,2,0) — matches .bm-btn:disabled, so order in source
   is what wins; declared after to take effect.
   Keep at the same (0,2,0) flat layer as other modifiers — never prefix
   with .base-modal__footer or the override silently loses. */
.bm-btn--primary:disabled,
.bm-btn--danger:disabled {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  border-color: var(--color-border);
  box-shadow: none;
  opacity: 1;
}
</style>

<script setup lang="ts">
/**
 * AiTemplateMenu — chevron half of an AI split button, opening a menu to pick
 * the repo's active AI template (Default + user templates) with a shortcut to
 * Settings → AI Templates. Same pattern as the commit summary's AI button.
 *
 * The parent owns the main "Generate" button and styles the chevron through
 * `chevronClass` (scoped parent styles reach it via `:deep(.atm-chevron)`).
 *
 * The menu is teleported to <body> with fixed positioning so a scrolling or
 * clipping ancestor (modal body, view container) never cuts it off.
 *
 * Above the templates, a Language row sets the kind's output language — the
 * same setting as Settings → AI Templates, so both stay in sync. With
 * `translatable`, picking a language also translates the current message.
 */
import { computed, inject, onUnmounted, ref, useTemplateRef } from "vue";
import { useI18n } from "../composables/useI18n";
import {
  builtinTemplates,
  useAiTemplates,
  requestedAiTemplateKind,
  type AiTemplateKind,
} from "../composables/useAiTemplates";
import { DEFAULT_TEMPLATE_ID } from "../composables/aiTemplateDefaults";
import { OPEN_SETTINGS_KEY } from "../composables/branchPickerBridge";
import { supportedLocales, localeLabels } from "../locales";

const props = defineProps<{
  kind: AiTemplateKind;
  cwd: string;
  disabled?: boolean;
  chevronClass?: string;
  /** Open the menu under the chevron (default) or above it. */
  placement?: "below" | "above";
  /** A message exists that picking a language should also translate (commit kind). */
  translatable?: boolean;
}>();

const emit = defineEmits<{
  /** A language was picked while `translatable`: translate the message into it. */
  (e: "translate", locale: string): void;
  /** Fired before Settings opens, e.g. so a modal host can close itself. */
  (e: "manage"): void;
}>();

const { t } = useI18n();
const { templates, activeTemplateId, activate, lang, setLang } = useAiTemplates(props.kind, () => props.cwd);
const openSettings = inject(OPEN_SETTINGS_KEY, undefined);
/** Read-only templates other than Default (the commit kind's Concise / Detailed / Emoji). */
const extraBuiltins = computed(() =>
  builtinTemplates(props.kind).filter((tpl) => tpl.id !== DEFAULT_TEMPLATE_ID),
);

const open = ref(false);
const menuPos = ref<{ top?: number; bottom?: number; right: number; maxHeight: number }>({ right: 0, maxHeight: 0 });
const chevron = useTemplateRef<HTMLButtonElement>("chevron");
const menu = useTemplateRef<HTMLDivElement>("menu");

function onOutside(e: MouseEvent) {
  const target = e.target as Node;
  if (chevron.value?.contains(target) || menu.value?.contains(target)) return;
  close();
}

/** Capture phase + stopPropagation: Escape closes the menu, not a host modal. */
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  close();
}

/** The menu is fixed-positioned: any outside scroll would detach it from the chevron. */
function onScroll(e: Event) {
  if (menu.value?.contains(e.target as Node)) return;
  close();
}

function listen(on: boolean) {
  if (on) {
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
  } else {
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", onScroll, true);
  }
}

function toggle() {
  if (open.value) return close();
  const rect = chevron.value?.getBoundingClientRect();
  if (!rect) return;
  const right = window.innerWidth - rect.right;
  // Never taller than the room on the chosen side; the template list scrolls
  // inside, the "Manage templates…" footer stays visible.
  menuPos.value = props.placement === "above"
    ? { bottom: window.innerHeight - rect.top + 4, right, maxHeight: Math.min(420, rect.top - 12) }
    : { top: rect.bottom + 4, right, maxHeight: Math.min(420, window.innerHeight - rect.bottom - 12) };
  open.value = true;
  listen(true);
}

function close() {
  if (!open.value) return;
  open.value = false;
  listen(false);
}

function pick(id: string | null) {
  activate(id);
  close();
}

/**
 * Sets the kind's output language and, when `translatable`, also asks the
 * host to translate the current message into it.
 */
function pickLang(loc: string) {
  setLang(loc);
  if (!props.translatable) return;
  close();
  emit("translate", loc);
}

function manage() {
  close();
  emit("manage");
  requestedAiTemplateKind.value = props.kind;
  openSettings?.("aiTemplates");
}

onUnmounted(close);
</script>

<template>
  <button
    ref="chevron"
    type="button"
    class="atm-chevron"
    :class="chevronClass"
    :disabled="disabled"
    v-tooltip="t('settings.aiTemplates.picker')"
    :aria-label="t('settings.aiTemplates.picker')"
    :aria-expanded="open"
    aria-haspopup="menu"
    @click.stop="toggle"
  >
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="atm-menu"
      :style="{
        top: menuPos.top !== undefined ? `${menuPos.top}px` : undefined,
        bottom: menuPos.bottom !== undefined ? `${menuPos.bottom}px` : undefined,
        right: `${menuPos.right}px`,
        maxHeight: `${menuPos.maxHeight}px`,
      }"
    >
      <p class="atm-note">{{ t('settings.aiTemplates.perProjectNote') }}</p>
      <ul class="atm-list" role="menu">
        <li class="atm-title">{{ t('settings.aiTemplates.language') }}</li>
        <li class="atm-langs" role="group" :aria-label="t('settings.aiTemplates.language')">
          <button
            v-for="loc in supportedLocales"
            :key="loc"
            type="button"
            class="atm-chip"
            :class="{ 'is-active': loc === lang }"
            :title="localeLabels[loc]"
            :aria-pressed="loc === lang"
            @click="pickLang(loc)"
          >{{ loc.split('-')[0].toUpperCase() }}</button>
        </li>
        <li class="atm-sep" role="separator"></li>
        <li class="atm-title">{{ t('settings.aiTemplates.picker') }}</li>
        <li role="menuitemradio" :aria-checked="!activeTemplateId"
          :class="{ 'is-active': !activeTemplateId }" @click="pick(null)">
          <svg v-if="!activeTemplateId" class="atm-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="atm-name">{{ t('settings.aiTemplates.default') }}</span>
        </li>
        <li v-for="tpl in [...extraBuiltins, ...templates]" :key="tpl.id" role="menuitemradio"
          :aria-checked="activeTemplateId === tpl.id"
          :class="{ 'is-active': activeTemplateId === tpl.id }" @click="pick(tpl.id)">
          <svg v-if="activeTemplateId === tpl.id" class="atm-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="atm-name">{{ tpl.name }}</span>
          <span v-if="tpl.description" class="atm-desc">{{ tpl.description }}</span>
        </li>
      </ul>
      <ul v-if="openSettings" class="atm-footer" role="menu">
          <li role="menuitem" class="atm-manage" @click="manage">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
              <path d="M2 4h12M2 8h8M2 12h10" stroke-linecap="round"/><circle cx="13" cy="12" r="2"/>
            </svg>
            {{ t('settings.aiTemplates.manage') }}
          </li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
.atm-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Above BaseModal (z-index 100), so it works inside dialogs too. */
.atm-menu {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  /* Wide enough for the per-project note in every locale (≤ 2 lines). */
  min-width: 300px;
  max-width: 340px;
  overflow: hidden;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
}
.atm-list,
.atm-footer {
  margin: 0;
  padding: var(--space-2) 0;
  list-style: none;
}
.atm-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.atm-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--color-border);
}
.atm-menu li {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* Everything left-aligned on one edge; the right gutter holds the check
     (9px inset + 12px icon) plus 7px of breathing room before it. */
  padding: var(--space-2) calc(9px + 12px + 7px) var(--space-2) var(--space-5);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--transition-hover);
}
.atm-menu li:hover {
  background: var(--color-bg-tertiary);
}
/* Language chips: a row of toggles, not a menu item. */
.atm-menu .atm-langs {
  flex-direction: row;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 0 var(--space-5) var(--space-2);
  cursor: default;
}
.atm-menu .atm-langs:hover {
  background: transparent;
}
.atm-chip {
  height: 24px;
  min-width: 34px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-hover), border-color var(--transition-hover);
}
.atm-chip:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent);
}
.atm-chip.is-active {
  color: var(--color-accent);
  border-color: var(--color-accent);
  font-weight: var(--font-weight-semibold);
}
.atm-menu .atm-title {
  padding-top: var(--space-1);
  padding-bottom: var(--space-2);
  font-size: 11.5px;
  font-weight: var(--font-weight-bold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: default;
}
.atm-menu .atm-title:hover {
  background: transparent;
}
.atm-check {
  position: absolute;
  right: 9px;
  top: 7px;
  color: var(--color-accent);
}
.atm-name,
.atm-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Same look as the commit panel's profile menu (RepoSidebar). */
.atm-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}
.atm-desc {
  font-size: 11px;
  color: var(--color-text-meta);
}
.atm-menu .atm-sep {
  height: 1px;
  margin: var(--space-2) 0;
  padding: 0;
  background: var(--color-border);
  cursor: default;
}
/* Fixed header above the scrolling list. */
.atm-note {
  flex-shrink: 0;
  margin: 0;
  padding: var(--space-3) 28px var(--space-3) var(--space-5);
  font-size: var(--font-size-xs);
  line-height: 1.35;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}
.atm-menu .atm-manage {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-5);
  color: var(--color-text);
}
</style>

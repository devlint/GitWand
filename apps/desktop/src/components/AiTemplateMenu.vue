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
 */
import { inject, onUnmounted, ref, useTemplateRef } from "vue";
import { useI18n } from "../composables/useI18n";
import { useAiTemplates, requestedAiTemplateKind, type AiTemplateKind } from "../composables/useAiTemplates";
import { OPEN_SETTINGS_KEY } from "../composables/branchPickerBridge";

const props = defineProps<{
  kind: AiTemplateKind;
  cwd: string;
  disabled?: boolean;
  chevronClass?: string;
}>();

const emit = defineEmits<{
  /** Fired before Settings opens, e.g. so a modal host can close itself. */
  (e: "manage"): void;
}>();

const { t } = useI18n();
const { templates, activeTemplateId, activate } = useAiTemplates(props.kind, () => props.cwd);
const openSettings = inject(OPEN_SETTINGS_KEY, undefined);

const open = ref(false);
const menuPos = ref({ top: 0, right: 0 });
const chevron = useTemplateRef<HTMLButtonElement>("chevron");
const menu = useTemplateRef<HTMLUListElement>("menu");

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
  menuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right };
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
    :title="t('settings.aiTemplates.picker')"
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
    <ul
      v-if="open"
      ref="menu"
      class="atm-menu"
      role="menu"
      :style="{ top: `${menuPos.top}px`, right: `${menuPos.right}px` }"
    >
      <li class="atm-title">{{ t('settings.aiTemplates.picker') }}</li>
      <li role="menuitemradio" :aria-checked="!activeTemplateId"
        :class="{ 'is-active': !activeTemplateId }" @click="pick(null)">
        <svg v-if="!activeTemplateId" class="atm-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="atm-name">{{ t('settings.aiTemplates.default') }}</span>
      </li>
      <li v-for="tpl in templates" :key="tpl.id" role="menuitemradio"
        :aria-checked="activeTemplateId === tpl.id"
        :class="{ 'is-active': activeTemplateId === tpl.id }" @click="pick(tpl.id)">
        <svg v-if="activeTemplateId === tpl.id" class="atm-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="atm-name">{{ tpl.name }}</span>
        <span v-if="tpl.description" class="atm-desc">{{ tpl.description }}</span>
      </li>
      <template v-if="openSettings">
        <li class="atm-sep" role="separator"></li>
        <li role="menuitem" class="atm-manage" @click="manage">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M2 4h12M2 8h8M2 12h10" stroke-linecap="round"/><circle cx="13" cy="12" r="2"/>
          </svg>
          {{ t('settings.aiTemplates.manage') }}
        </li>
      </template>
    </ul>
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
  min-width: 220px;
  max-width: 320px;
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
  padding: var(--space-2) 0;
  list-style: none;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
}
.atm-menu li {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-2) var(--space-5) var(--space-2) 28px;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--transition-hover);
}
.atm-menu li:hover {
  background: var(--color-bg-tertiary);
}
.atm-menu li.is-active .atm-name {
  font-weight: var(--font-weight-semibold);
}
.atm-menu .atm-title {
  padding-top: var(--space-1);
  padding-bottom: var(--space-2);
  font-size: var(--font-size-xs);
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
  left: 9px;
  top: 7px;
  color: var(--color-accent);
}
.atm-name,
.atm-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.atm-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.atm-menu .atm-sep {
  height: 1px;
  margin: var(--space-2) 0;
  padding: 0;
  background: var(--color-border);
  cursor: default;
}
.atm-menu .atm-manage {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-5);
  color: var(--color-text-muted);
}
.atm-menu .atm-manage:hover {
  color: var(--color-text);
}
</style>

<script setup lang="ts">
/**
 * StackBranchMenu — the stack items of a local branch's right-click menu in
 * the header branch selector (v3.14): "Stack on…", "Unstack", "Restack…".
 * Same look as the other branch context menus (global `.ctx-menu` /
 * `.ctx-item` classes, teleported to <body>), kept inside the window like the
 * Git Tree menu. The actions themselves live in useStackActions; "Stack on…"
 * only requests the dialog that StackOnHost mounts.
 *
 * Keyboard: the first item takes focus on open, the arrow keys move between
 * items, Escape closes and gives focus back to what had it. Any item, a click
 * outside or a right-click outside closes it too. `picked` tells the parent an
 * item ran (the branch selector then closes its popover).
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "../composables/useI18n";
import { useStackActions, type StackMenuItems } from "../composables/useStackActions";
import { clampMenuToWindow } from "../utils/contextMenu";

const props = defineProps<{
  cwd: string;
  branch: string;
  items: StackMenuItems;
  x: number;
  y: number;
}>();

const emit = defineEmits<{ close: []; picked: [] }>();

const { t } = useI18n();
const actions = useStackActions();
const el = ref<HTMLElement | null>(null);
const pos = ref({ x: props.x, y: props.y });
/** What had focus before the menu opened: Escape gives it back. */
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

const buttons = () => Array.from(el.value?.querySelectorAll<HTMLButtonElement>(".ctx-item") ?? []);

/** Place at the pointer, pulled back inside the window, and focus the first item. */
async function place() {
  pos.value = { x: props.x, y: props.y };
  await nextTick();
  if (!el.value) return;
  pos.value = clampMenuToWindow(pos.value, el.value);
  buttons()[0]?.focus();
}
watch(() => [props.branch, props.x, props.y], place);

function run(item: keyof StackMenuItems) {
  const { cwd, branch } = props;
  emit("picked");
  emit("close");
  if (item === "stackOn") actions.requestStackOn(cwd, branch);
  else if (item === "unstack") void actions.unstack(cwd, branch);
  else void actions.restackFrom(cwd, branch);
}

function onMenuKey(e: KeyboardEvent) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const list = buttons();
  if (list.length === 0) return;
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  const step = e.key === "ArrowDown" ? 1 : -1;
  list[(at + step + list.length) % list.length].focus();
}

const outside = (e: Event) => !el.value?.contains(e.target as Node);
function onDocClick(e: MouseEvent) {
  if (outside(e)) emit("close");
}
/** Capture phase: runs before a row's own handler, which may reopen the menu there. */
function onDocContextMenu(e: MouseEvent) {
  if (outside(e)) emit("close");
}
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  emit("close");
  returnFocus?.focus();
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("contextmenu", onDocContextMenu, true);
  document.addEventListener("keydown", onKey);
  void place();
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("contextmenu", onDocContextMenu, true);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="ctx-menu stack-branch-menu"
      role="menu"
      :aria-label="branch"
      :style="{ top: pos.y + 'px', left: pos.x + 'px' }"
      @contextmenu.prevent
      @keydown="onMenuKey"
    >
      <button v-if="items.stackOn" type="button" class="ctx-item" role="menuitem" @click="run('stackOn')">
        {{ t('stacks.menu.stackOn') }}
      </button>
      <button v-if="items.unstack" type="button" class="ctx-item" role="menuitem" @click="run('unstack')">
        {{ t('stacks.menu.unstack') }}
      </button>
      <button v-if="items.restack" type="button" class="ctx-item" role="menuitem" @click="run('restack')">
        {{ t('stacks.menu.restack') }}
      </button>
    </div>
  </Teleport>
</template>

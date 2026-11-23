<script setup lang="ts">
/**
 * StackBranchMenu — the stack items of a local branch's right-click menu in
 * the header branch selector (v3.14): "Stack on…", "Unstack", "Restack…".
 * Same look as the other branch context menus (global `.ctx-menu` /
 * `.ctx-item` classes, teleported to <body>). The actions themselves live in
 * useStackActions; "Stack on…" only requests the dialog that StackOnHost
 * mounts. Closes on any item, Escape, or a click outside.
 */
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../composables/useI18n";
import { useStackActions, type StackMenuItems } from "../composables/useStackActions";

const props = defineProps<{
  cwd: string;
  branch: string;
  items: StackMenuItems;
  x: number;
  y: number;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const actions = useStackActions();
const el = ref<HTMLElement | null>(null);

function run(item: keyof StackMenuItems) {
  const { cwd, branch } = props;
  emit("close");
  if (item === "stackOn") actions.requestStackOn(cwd, branch);
  else if (item === "unstack") void actions.unstack(cwd, branch);
  else void actions.restackFrom(cwd, branch);
}

function onDocClick(e: MouseEvent) {
  if (!el.value?.contains(e.target as Node)) emit("close");
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="ctx-menu stack-branch-menu"
      role="menu"
      :style="{ top: y + 'px', left: x + 'px' }"
      @contextmenu.prevent
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

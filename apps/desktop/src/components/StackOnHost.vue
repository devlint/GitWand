<script setup lang="ts">
/**
 * StackOnHost — the one place StackOnDialog is mounted (v3.14). The branch
 * menus (Git Tree, header branch selector) only call
 * `useStackActions().requestStackOn`; this host opens the dialog from that
 * request. App.vue mounts this host lazily, only while a request is pending.
 */
import { computed } from "vue";
import { useStacks } from "../composables/useStacks";
import { useStackActions } from "../composables/useStackActions";
import StackOnDialog from "./StackOnDialog.vue";

const stacks = useStacks();
const { stackOnRequest, closeStackOn } = useStackActions();
/** Only a request made in the open repository (QA2 item 7). */
const request = computed(() => {
  const r = stackOnRequest.value;
  return r && r.cwd === stacks.context.value.cwd ? r : null;
});
</script>

<template>
  <StackOnDialog
    v-if="request"
    :key="`${request.cwd}\u0000${request.branch}`"
    :cwd="request.cwd"
    :branch="request.branch"
    :candidates="stacks.stackOnCandidates(request.branch)"
    :forge="stacks.context.value.forge"
    @close="closeStackOn"
  />
</template>

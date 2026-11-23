<script setup lang="ts">
/**
 * StackOnHost — the one place StackOnDialog is mounted (v3.14). The branch
 * menus (Git Tree, header branch selector) only call
 * `useStackActions().requestStackOn`; this host opens the dialog from that
 * request. App.vue mounts this host lazily, only while a request is pending.
 */
import { useStacks } from "../composables/useStacks";
import { useStackActions } from "../composables/useStackActions";
import StackOnDialog from "./StackOnDialog.vue";

const stacks = useStacks();
const { stackOnRequest, closeStackOn } = useStackActions();
</script>

<template>
  <StackOnDialog
    v-if="stackOnRequest"
    :key="`${stackOnRequest.cwd}\u0000${stackOnRequest.branch}`"
    :cwd="stackOnRequest.cwd"
    :branch="stackOnRequest.branch"
    :candidates="stacks.stackOnCandidates(stackOnRequest.branch)"
    :forge="stacks.context.value.forge"
    @close="closeStackOn"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { parseInline } from '@gitwand/advent'

const props = defineProps<{ text: string }>()

// Rendered as text nodes and elements only: no v-html.
const segments = computed(() => parseInline(props.text))
</script>

<template>
  <template v-for="(seg, i) in segments" :key="i">
    <code v-if="seg.kind === 'code'" class="adv-code">{{ seg.text }}</code>
    <strong v-else-if="seg.kind === 'strong'">{{ seg.text }}</strong>
    <template v-else>{{ seg.text }}</template>
  </template>
</template>

<style scoped>
.adv-code {
  font-family: var(--nc-font-mono);
  font-size: 0.88em;
  color: var(--nc-accent-200);
  background: color-mix(in srgb, var(--nc-accent) 16%, transparent);
  border-radius: var(--nc-radius-sm);
  padding: 0.1em 0.35em;
}
</style>

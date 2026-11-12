<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adventBadge, resolveNow } from './advent-state'

// Client-only: the nav is static at build time, so the date check runs after mount.
const href = ref<string | null>(null)
onMounted(() => {
  href.value = adventBadge(resolveNow(location.search, new Date()))?.href ?? null
})
</script>

<template>
  <a v-if="href" class="advent-nav-link" :href="href">Advent 🎄</a>
</template>

<style scoped>
.advent-nav-link {
  display: flex;
  align-items: center;
  padding: 0 12px;
  line-height: var(--vp-nav-height);
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: color 0.25s;
}
.advent-nav-link:hover {
  color: var(--vp-c-brand-1);
}
/* Same divider VitePress draws between nav groups (appearance, social links). */
@media (min-width: 768px) {
  .advent-nav-link::before {
    content: '';
    width: 1px;
    height: 24px;
    margin-right: 12px;
    background-color: var(--vp-c-divider);
  }
}
@media (max-width: 768px) {
  .advent-nav-link {
    padding: 0 8px;
    font-size: 13px;
  }
}
</style>

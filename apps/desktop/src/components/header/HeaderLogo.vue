<script setup lang="ts">
/**
 * HeaderLogo — GitWand wordmark + hex icon in the header.
 *
 * Pulled out of AppHeader.vue so the new header layout can place the
 * logo independently of the repo-selector popover (which used to live
 * glued to the right of the title). Pure presentation: no props, no
 * events. The SVG colour stops are baked in because the logo is a
 * brand mark and should not drift with theme tokens.
 */
import { useI18n } from "../../composables/useI18n";

const { t } = useI18n();
</script>

<template>
  <div class="header-logo" role="img" :aria-label="t('header.title')">
    <!-- 3D hex cube — flat-top R=30, inner r=15, viewBox 80×70.
         Same geometry as the pre-extraction inline version so the
         pixel-by-pixel look is unchanged. -->
    <svg class="header-logo__mark" width="22" height="19" viewBox="0 0 80 70" fill="none" aria-hidden="true">
      <path d="M 55,35 L 47.5,22 L 32.5,22 L 25,35 L 32.5,48 L 47.5,48 Z" fill="none" />
      <path d="M 10,35 L 25,9 L 55,9 L 70,35 L 55,35 L 47.5,22 L 32.5,22 L 25,35 Z" fill="#8B5CF6" />
      <path d="M 70,35 L 55,61 L 47.5,48 L 55,35 Z" fill="#4C1D95" />
      <path d="M 10,35 L 25,35 L 32.5,48 L 25,61 Z" fill="#6D28D9" />
      <path d="M 25,61 L 55,61 L 47.5,48 L 32.5,48 Z" fill="#5B21B6" />
    </svg>
    <h1 class="header-logo__title">{{ t('header.title') }}</h1>
  </div>
</template>

<style scoped>
.header-logo {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}

.header-logo__mark {
  flex-shrink: 0;
}

.header-logo__title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
  margin: 0;
}
</style>

<script setup lang="ts">
/**
 * AiSparkle — unified sparkle icon for every AI-assisted CTA in the app.
 *
 * Paired with `.btn--ai` this gives every "suggest / explain / generate
 * with AI" action the same mark: two four-point stars (one large + one
 * small satellite), pulsing softly. Colour inherits via `currentColor`
 * so it picks up `--color-ai` (or white on hover/solid variants)
 * automatically.
 *
 * Props:
 *  - size: pixel size of the bounding box (default 14). Icon-only
 *    buttons use 16; inline-with-label uses 14.
 *  - animated: set to false for static contexts (e.g. tooltips,
 *    disabled state where the pulse feels distracting).
 *  - busy: swap the sparkle for a same-size spinner while the AI
 *    request is in flight.
 */
defineProps<{
  size?: number;
  animated?: boolean;
  busy?: boolean;
}>();
</script>

<template>
  <span
    v-if="busy"
    class="ai-sparkle-spinner"
    :style="{ width: `${size ?? 14}px`, height: `${size ?? 14}px` }"
    aria-hidden="true"
  ></span>
  <svg
    v-else
    class="ai-sparkle"
    :class="{ 'ai-sparkle--animated': animated !== false }"
    :width="size ?? 14"
    :height="size ?? 14"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <!-- Main 4-point star -->
    <path
      d="M12 2l2.2 6.6L20.8 12l-6.6 2.2L12 20.8l-2.2-6.6L3.2 12l6.6-2.2L12 2z"
      fill="currentColor"
    />
    <!-- Satellite sparkle -->
    <path
      d="M19 3l.9 2.7L22.5 6l-2.6.7L19 9.3l-.9-2.7L15.5 6l2.6-.7L19 3z"
      fill="currentColor"
      opacity="0.7"
    />
  </svg>
</template>

<style scoped>
.ai-sparkle {
  flex-shrink: 0;
  display: inline-block;
  vertical-align: middle;
  filter: drop-shadow(0 0 2px var(--color-ai-soft));
}

.ai-sparkle--animated {
  animation: ai-sparkle-pulse 2.4s ease-in-out infinite;
}

@keyframes ai-sparkle-pulse {
  0%, 100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.08);
    opacity: 0.85;
  }
}

.ai-sparkle-spinner {
  flex-shrink: 0;
  display: inline-block;
  vertical-align: middle;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* Respect reduced-motion preference — keep the icon, drop the pulse. */
@media (prefers-reduced-motion: reduce) {
  .ai-sparkle--animated,
  .ai-sparkle-spinner {
    animation: none;
  }
}
</style>

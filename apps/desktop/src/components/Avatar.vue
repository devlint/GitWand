<script setup lang="ts">
/**
 * Avatar — app-wide avatar disk with photo + colored-initials fallback.
 *
 * Renders a profile photo when one is available (an explicit forge `url`, else
 * a Gravatar derived from `email`) and falls back to the deterministic
 * colored-initials disk (see composables/useAvatar) when there is no photo or
 * it fails to load. Single root <span>, so the caller's sizing class (width /
 * height / border-radius / font-size) falls through and styles it — drop-in for
 * the previous `<span :style="avatarStyle(k)">{{ initials(k) }}</span>` markup.
 */
import { computed, ref, watch } from "vue";
import { avatarInitials, avatarStyle, gravatarUrl } from "../composables/useAvatar";

const props = defineProps<{
  /** Display name — source for the initials and (with email) the color key. */
  name?: string | null;
  /** Email — used for the Gravatar lookup and preferred as the color key. */
  email?: string | null;
  /** Explicit photo URL (e.g. a forge avatar); takes precedence over Gravatar. */
  url?: string | null;
  /** Rendered size hint passed to Gravatar (CSS still controls display size). */
  size?: number;
}>();

// Preserve the previous color/initials keying: color keyed by email||name.
const colorKey = computed(() => props.email || props.name || "");
const initialsKey = computed(() => props.name || props.email || "");

const broken = ref(false);
const resolvedUrl = ref<string | null>(null);

watch(
  () => [props.url, props.email, props.size] as const,
  async ([url, email, size]) => {
    broken.value = false;
    if (url) {
      resolvedUrl.value = url;
      return;
    }
    resolvedUrl.value = await gravatarUrl(email, size ?? 48);
  },
  { immediate: true },
);

const showPhoto = computed(() => !!resolvedUrl.value && !broken.value);
</script>

<template>
  <span
    class="gw-avatar"
    :class="{ 'gw-avatar--photo': showPhoto }"
    :style="showPhoto ? undefined : avatarStyle(colorKey)"
    aria-hidden="true"
  >
    <img
      v-if="showPhoto"
      :src="resolvedUrl!"
      class="gw-avatar__img"
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      @error="broken = true"
    />
    <template v-else>{{ avatarInitials(initialsKey) }}</template>
  </span>
</template>

<style scoped>
.gw-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
}
/* Photo mode: hide the initials-disk colored border behind the image. */
.gw-avatar--photo {
  border-color: transparent !important;
  background: var(--color-bg-tertiary);
}
.gw-avatar__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
</style>

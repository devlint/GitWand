<script setup lang="ts">
/**
 * Avatar — app-wide avatar disk with a cascading photo + colored-initials
 * fallback chain.
 *
 * Tries, in order: the explicit forge `url`, then a Gravatar derived from
 * `email`, then the deterministic colored-initials disk (see
 * composables/useAvatar). Each photo source that fails to load (or is
 * unavailable) advances to the next stage — so a broken forge avatar still
 * gets a chance at Gravatar before falling back to initials. Single root
 * <span>, so the caller's sizing class (width / height / border-radius /
 * font-size) falls through and styles it — drop-in for the previous
 * `<span :style="avatarStyle(k)">{{ initials(k) }}</span>` markup.
 */
import { computed, ref, watch } from "vue";
import { avatarInitials, avatarStyle, gravatarUrl, githubAvatarFromEmail } from "../composables/useAvatar";

const props = defineProps<{
  /** Display name — source for the initials and (with email) the color key. */
  name?: string | null;
  /** Email — used for the Gravatar lookup and preferred as the color key. */
  email?: string | null;
  /** Explicit photo URL (e.g. a forge avatar); tried before Gravatar. */
  url?: string | null;
  /** Rendered size hint passed to Gravatar (CSS still controls display size). */
  size?: number;
}>();

// Preserve the previous color/initials keying: color keyed by email||name.
const colorKey = computed(() => props.email || props.name || "");
const initialsKey = computed(() => props.name || props.email || "");

// Fallback chain: "forge" → "gravatar" → "initials".
type Stage = "forge" | "gravatar" | "initials";
const stage = ref<Stage>("initials");
const forgeUrl = ref<string | null>(null);
const gravatar = ref<string | null>(null);

watch(
  () => [props.url, props.email, props.size] as const,
  async ([url, email, size]) => {
    // Explicit forge URL wins; otherwise try to derive a GitHub avatar straight
    // from a `users.noreply.github.com` commit email (git-log views have no
    // forge login, only name+email — this recovers the forge photo for free).
    forgeUrl.value = url ?? githubAvatarFromEmail(email, size ?? 48);
    gravatar.value = await gravatarUrl(email, size ?? 48);
    // Start at the first stage that has a candidate photo.
    stage.value = forgeUrl.value ? "forge" : gravatar.value ? "gravatar" : "initials";
  },
  { immediate: true },
);

// Advance to the next available stage when the current photo fails to load.
function onError() {
  if (stage.value === "forge") stage.value = gravatar.value ? "gravatar" : "initials";
  else if (stage.value === "gravatar") stage.value = "initials";
}

const resolvedUrl = computed(() => (stage.value === "forge" ? forgeUrl.value : stage.value === "gravatar" ? gravatar.value : null));
const showPhoto = computed(() => !!resolvedUrl.value);
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
      @error="onError"
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

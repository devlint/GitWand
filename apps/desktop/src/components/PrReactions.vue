<script setup lang="ts">
/**
 * PrReactions.vue
 *
 * Emoji reaction strip for PR descriptions and comments.
 * Fetches reactions on mount, groups them as pills, and lets
 * authenticated users toggle reactions or pick new ones.
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import { ghListReactions, ghAddReaction, ghDeleteReaction, type PrReaction, azListLikes, azAddLike, azDeleteLike } from "../utils/backend";
import { glListReactions, glAddReaction, glDeleteReaction } from "../utils/backend-gitlab";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  cwd: string;
  prNumber: number;
  /** "pr" | "review_comment" | "issue_comment" */
  targetType: string;
  /** PR number for "pr", comment id otherwise. */
  targetId: number;
  currentUser?: string | null;
  forgeName?: string;
}>();

const SUPPORTED = new Set(["github", "gitlab", "azure"]);

const EMOJI: Record<string, string> = {
  "+1": "👍", "-1": "👎", laugh: "😄", confused: "😕",
  heart: "❤️", hooray: "🎉", rocket: "🚀", eyes: "👀",
};
const PICKER_ORDER = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];

const reactions = ref<PrReaction[]>([]);
const showPicker = ref(false);
const busy = ref(false);

const groups = computed(() => {
  const map = new Map<string, { count: number; myReactionId: number | null }>();
  for (const r of reactions.value) {
    const g = map.get(r.content) ?? { count: 0, myReactionId: null };
    g.count++;
    if (r.user === props.currentUser) g.myReactionId = r.id;
    map.set(r.content, g);
  }
  return PICKER_ORDER
    .filter(c => map.has(c))
    .map(c => ({ content: c, ...map.get(c)! }));
});

// Azure only supports likes on comments, not on the PR description itself.
const isAzure = computed(() => props.forgeName === "azure");

// A review *verdict* is reactable only on GitHub (via GraphQL); no other forge
// exposes a reaction target for it. Centralised here so call sites stay forge-agnostic.
const reviewUnsupported = computed(() => props.targetType === "review" && props.forgeName !== "github");

// One adapter per forge resolves the list/add/delete calls. Azure ("likes")
// ignores targetType/content and has no reaction id, so its add/delete take
// no extra args — the differing signatures are hidden behind this table so
// each operation below stays a one-liner.
const api = computed(() => {
  const { cwd, prNumber, targetType, targetId } = props;
  if (props.forgeName === "gitlab") {
    return {
      list: () => glListReactions(cwd, prNumber, targetType, targetId),
      add: (content: string) => glAddReaction(cwd, prNumber, targetType, targetId, content),
      del: (id: number) => glDeleteReaction(cwd, prNumber, targetType, targetId, id),
    };
  }
  if (isAzure.value) {
    return {
      list: () => azListLikes(cwd, prNumber, targetId),
      add: (_content: string) => azAddLike(cwd, prNumber, targetId),
      del: (_id: number) => azDeleteLike(cwd, prNumber, targetId),
    };
  }
  return {
    list: () => ghListReactions(cwd, prNumber, targetType, targetId),
    add: (content: string) => ghAddReaction(cwd, prNumber, targetType, targetId, content),
    del: (id: number) => ghDeleteReaction(cwd, prNumber, targetType, targetId, id),
  };
});

onMounted(async () => {
  document.addEventListener("click", onDocClick, true);
  if (!props.cwd || !props.prNumber || !SUPPORTED.has(props.forgeName ?? "")) return;
  // Azure has no PR-level likes — only comment threads support them.
  if (isAzure.value && props.targetType === "pr") return;
  if (reviewUnsupported.value) return;
  try {
    reactions.value = await api.value.list();
  } catch {
    // Reactions unavailable (no auth, wrong forge, etc.) — show nothing.
  }
});

async function toggle(content: string) {
  if (!props.currentUser || busy.value) return;
  busy.value = true;
  showPicker.value = false;
  try {
    const mine = reactions.value.find(r => r.content === content && r.user === props.currentUser);
    if (mine) {
      await api.value.del(mine.id);
      reactions.value = reactions.value.filter(r => r.id !== mine.id);
    } else {
      const created = await api.value.add(content);
      reactions.value = [...reactions.value, created];
    }
  } catch {
    // Silently ignore failures (token revoked, network, etc.)
  } finally {
    busy.value = false;
  }
}

function onDocClick(e: MouseEvent) {
  if (!showPicker.value) return;
  if (!(e.target as HTMLElement).closest(".prt-picker-wrap")) {
    showPicker.value = false;
  }
}

onUnmounted(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <!-- Azure: simplified 👍-only UI, no picker -->
  <div
    v-if="isAzure && targetType !== 'pr' && (reactions.length > 0 || currentUser)"
    class="prt-reactions"
  >
    <button
      :class="['prt-pill', { 'prt-pill--active': reactions.some(r => r.user === currentUser) }]"
      :disabled="busy || !currentUser"
      @click="toggle('+1')"
    >👍&thinsp;{{ reactions.length }}</button>
  </div>

  <!-- GitHub / GitLab: full emoji picker -->
  <div v-else-if="!isAzure && !reviewUnsupported && SUPPORTED.has(forgeName ?? '') && (groups.length > 0 || currentUser)" class="prt-reactions">
    <button
      v-for="g in groups"
      :key="g.content"
      :class="['prt-pill', { 'prt-pill--active': g.myReactionId !== null }]"
      :title="g.content"
      :disabled="busy || !currentUser"
      @click="toggle(g.content)"
    >
      {{ EMOJI[g.content] || g.content }}&thinsp;{{ g.count }}
    </button>

    <div v-if="currentUser" class="prt-picker-wrap">
      <button
        class="prt-add-btn"
        :title="t('pr.reactions.addReaction')"
        :aria-label="t('pr.reactions.addReaction')"
        @click.stop="showPicker = !showPicker"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M5 1v8M1 5h8" />
        </svg>
      </button>
      <div v-if="showPicker" class="prt-picker">
        <button
          v-for="c in PICKER_ORDER"
          :key="c"
          class="prt-picker-btn"
          :title="c"
          @click="toggle(c)"
        >{{ EMOJI[c] }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prt-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin-top: 6px;
}

.prt-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
  color: var(--color-text);
  line-height: 1.4;
}
.prt-pill:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent);
}
.prt-pill--active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.prt-pill:disabled {
  cursor: default;
  opacity: 0.7;
}

.prt-picker-wrap {
  position: relative;
}

.prt-add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  background: var(--color-bg-secondary);
  border: 1px solid color-mix(in srgb, var(--color-text) 40%, var(--color-border));
  border-radius: var(--radius-sm);
  font-size: 14px;
  cursor: pointer;
  color: var(--color-text);
  transition: background 0.1s, color 0.1s, border-color 0.1s;
  line-height: 1;
}
.prt-add-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.prt-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 4px;
  display: flex;
  gap: 2px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.prt-picker-btn {
  background: none;
  border: none;
  padding: 4px 6px;
  font-size: 16px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.1s;
  line-height: 1;
}
.prt-picker-btn:hover {
  background: var(--color-bg-secondary);
}
</style>

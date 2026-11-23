<script setup lang="ts">
/**
 * StackBadge — branch-row badge for stacked branches (v3.14): the parent,
 * the layer's state, a Restack button, and the bridge chip offering to stack
 * a branch whose open PR targets another local branch. Pure rendering: the
 * host wires the events to useStacks.
 */
import { computed } from "vue";
import { useI18n } from "../composables/useI18n";
import type { StackLayerStatus } from "../utils/backend";
import type { BridgeOffer } from "../composables/useStacks";

const props = defineProps<{
  layer: StackLayerStatus | null;
  offer: BridgeOffer | null;
  /** The parent's PR number, when known (spec §5.5: `↳ main · #812`). */
  parentPr?: number | null;
}>();

defineEmits<{
  restack: [];
  acceptOffer: [];
  dismissOffer: [];
}>();

const { t } = useI18n();

/** An inherited layer is out of date because a layer below it is. */
const stateLabel = computed(() => {
  const l = props.layer;
  if (!l) return null;
  if (l.inherited) return t("stacks.state.out_of_date");
  if (l.state === "up_to_date") return null;
  return t(`stacks.state.${l.state}`);
});
</script>

<template>
  <span v-if="layer || offer" class="stack-badge" @click.stop>
    <template v-if="layer">
      <span class="stack-badge__parent mono" :title="layer.parent">{{
        parentPr != null ? t('stacks.badge.parentPr', layer.parent, parentPr) : t('stacks.badge.parent', layer.parent)
      }}</span>
      <span v-if="stateLabel" class="stack-badge__state">{{ stateLabel }}</span>
      <button v-if="layer.actionable" type="button" class="stack-badge__btn" @click="$emit('restack')">
        {{ t('stacks.restack') }}
      </button>
    </template>
    <span v-if="offer" class="stack-badge__offer">
      <span class="stack-badge__prompt">{{ t('stacks.bridge.prompt', offer.branch, offer.parent) }}</span>
      <button type="button" class="stack-badge__btn stack-badge__btn--primary" @click="$emit('acceptOffer')">
        {{ t('stacks.bridge.accept') }}
      </button>
      <button type="button" class="stack-badge__btn" @click="$emit('dismissOffer')">
        {{ t('stacks.bridge.dismiss') }}
      </button>
    </span>
  </span>
</template>

<style scoped>
.stack-badge {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.stack-badge__parent {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 14ch;
}
.stack-badge__state {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-warning, #f9e2af) 15%, transparent);
  color: var(--color-warning, #f9e2af);
  white-space: nowrap;
}
.stack-badge__offer {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.stack-badge__btn {
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
}
.stack-badge__btn:hover {
  background: var(--color-bg-hover, var(--color-bg-tertiary));
}
.stack-badge__btn--primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-contrast, #fff);
}
</style>

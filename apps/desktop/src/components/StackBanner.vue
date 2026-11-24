<script setup lang="ts">
/**
 * StackBanner — v3.14 stacked branches (spec §6, D12). A strip at the top of
 * every view (App.vue, under the rebase banner) that renders `useStacks()`:
 *
 *   restack mode → the current branch's lowest layer that needs attention,
 *                  with Preview restack / Later (Unstack when no restack can
 *                  help), plus one row per pending record that could not be
 *                  settled, with Unstack of its top;
 *   after mode   → what happened after a finalized restack in the open repo:
 *                  the PR retarget, the merged-parent delete offer, a failed
 *                  switch back.
 *
 * Renders only; the store holds the state and runs the git/forge calls.
 */
import { computed } from "vue";
import { useI18n } from "../composables/useI18n";
import { useStacks } from "../composables/useStacks";
import { useStackActions } from "../composables/useStackActions";
import { forgeDisplayName } from "../utils/forgeNames";

const { t } = useI18n();
const stacks = useStacks();
const actions = useStackActions();

const cwd = computed(() => stacks.context.value.cwd);
const trunk = computed(() => stacks.report.value?.trunk ?? "");
const model = computed(() => stacks.banner.value);

/** The after-restack block belongs to the repo it ran in (ruling 2). */
const after = computed(() => {
  const a = stacks.after.value;
  return a && a.cwd === cwd.value ? a : null;
});

const restackText = computed(() => {
  const m = model.value;
  if (!m) return "";
  const { branch, parent, merged_pr } = m.layer;
  switch (m.kind) {
    case "parent_moved":
      return t("stacks.banner.parent_moved", parent, branch);
    case "parent_merged": {
      const into = m.mergedInto ?? trunk.value;
      return merged_pr != null
        ? t("stacks.banner.parentMergedPr", parent, into, merged_pr)
        : t("stacks.banner.parent_merged", parent, into);
    }
    case "parent_behind":
      return t("stacks.banner.parent_behind", parent);
    case "parent_missing":
      return t("stacks.banner.parent_missing", parent);
    case "base_lost":
      return t("stacks.banner.base_lost", branch, parent);
  }
  return "";
});

/** Preview only where a restack can run now: never for a blocked chain (ruling 3). */
const canPreview = computed(() => {
  const m = model.value;
  return (
    !!m &&
    (m.kind === "parent_moved" || m.kind === "parent_merged") &&
    m.layer.actionable &&
    !stacks.isBlocked(m.layer.branch)
  );
});
const canUnstackLayer = computed(() => model.value?.kind === "parent_missing" || model.value?.kind === "base_lost");

const retargetText = computed(() => {
  const a = after.value;
  if (!a) return "";
  const r = a.retarget;
  switch (r.state) {
    case "done":
      return t("stacks.after.retargeted", r.number ?? "", r.base ?? "");
    case "failed":
      return t("stacks.after.retargetFailed", r.number ?? "", r.base ?? "", r.error ?? "");
    case "manual": {
      const forge = forgeDisplayName(stacks.context.value.forge);
      const base = a.finalized.new_parent ?? trunk.value;
      return forge
        ? t("stacks.after.retargetManual", a.finalized.bottom, base, forge)
        : t("stacks.after.retargetManualNoForge", a.finalized.bottom, base);
    }
    default:
      return "";
  }
});

const switchText = computed(() => {
  const e = after.value?.finalized.switch_error;
  return e ? t("stacks.after.switchFailed", e.branch, e.reason) : "";
});

const visible = computed(
  () => !!stacks.statusError.value || !!model.value || stacks.pendingErrors.value.length > 0 || !!after.value,
);

function preview() {
  const m = model.value;
  if (m && cwd.value) void actions.preview(cwd.value, m.layer.branch);
}

function unstack(branch: string | null) {
  if (branch && cwd.value) void actions.unstack(cwd.value, branch);
}
</script>

<template>
  <div v-if="visible" class="stack-banner" role="status">
    <div v-if="stacks.statusError.value" class="stack-banner__row stack-banner__row--warn">
      <span class="stack-banner__text">{{ t("stacks.banner.statusError", stacks.statusError.value) }}</span>
    </div>
    <div v-for="e in stacks.pendingErrors.value" :key="e.top" class="stack-banner__row stack-banner__row--warn">
      <span class="stack-banner__text">{{ t("stacks.banner.pendingError", e.top, e.error) }}</span>
      <button class="btn btn--secondary btn--sm" @click="unstack(e.top)">{{ t("stacks.menu.unstack") }}</button>
    </div>

    <div v-if="model" class="stack-banner__row">
      <span class="stack-banner__text">
        {{ restackText }}
        <template v-if="model.kind === 'parent_merged'"> {{ t("stacks.banner.oldCommits", model.layer.branch) }}</template>
      </span>
      <button v-if="canPreview" class="btn btn--primary btn--sm" @click="preview">
        {{ t("stacks.banner.preview") }}
      </button>
      <button v-if="canUnstackLayer" class="btn btn--secondary btn--sm" @click="unstack(model.layer.branch)">
        {{ t("stacks.menu.unstack") }}
      </button>
      <button class="btn btn--secondary btn--sm" @click="stacks.later()">{{ t("stacks.banner.later") }}</button>
    </div>

    <div v-if="after" class="stack-banner__after">
      <div v-if="retargetText" class="stack-banner__row">
        <span class="stack-banner__text">{{ retargetText }}</span>
        <button v-if="after.retarget.state === 'failed'" class="btn btn--secondary btn--sm" @click="actions.retryRetarget()">
          {{ t("stacks.after.retry") }}
        </button>
      </div>
      <div v-if="switchText" class="stack-banner__row stack-banner__row--warn">
        <span class="stack-banner__text">{{ switchText }}</span>
      </div>
      <div v-if="after.deleteOffer" class="stack-banner__row">
        <button class="btn btn--secondary btn--sm" @click="actions.deleteMergedParent()">
          {{ t("stacks.after.deleteParent", after.deleteOffer.branch) }}
        </button>
      </div>
      <button
        class="stack-banner__dismiss"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        @click="stacks.dismissAfter()"
      >✕</button>
    </div>
  </div>
</template>

<style scoped>
.stack-banner {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-6);
  border-left: 3px solid var(--color-accent);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.4;
}
.stack-banner__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.stack-banner__row--warn .stack-banner__text {
  color: var(--color-warning, var(--color-text));
}
.stack-banner__text {
  flex: 1 1 16rem;
  min-width: 0;
  color: var(--color-text);
}
.stack-banner__after {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-right: var(--space-5);
}
.stack-banner__dismiss {
  position: absolute;
  top: 0;
  right: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
</style>

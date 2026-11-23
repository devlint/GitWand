<script setup lang="ts">
/**
 * StackBanner — v3.14 stacked branches (spec §6, D12). Sits above the commit
 * panel and renders `useStacks()`:
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
    case "parent_merged":
      return merged_pr != null
        ? t("stacks.banner.parentMergedPr", parent, trunk.value, merged_pr)
        : t("stacks.banner.parent_merged", parent, trunk.value);
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

const visible = computed(() => !!model.value || stacks.pendingErrors.value.length > 0 || !!after.value);

function preview() {
  const m = model.value;
  if (m && cwd.value) void stacks.startRestack(cwd.value, m.layer.branch);
}

function unstack(branch: string | null) {
  if (branch && cwd.value) void actions.unstack(cwd.value, branch);
}
</script>

<template>
  <div v-if="visible" class="stack-banner" role="status">
    <div v-for="e in stacks.pendingErrors.value" :key="e.top" class="stack-banner__row stack-banner__row--warn">
      <span class="stack-banner__text">{{ t("stacks.banner.pendingError", e.top, e.error) }}</span>
      <button class="stack-banner__btn" @click="unstack(e.top)">{{ t("stacks.menu.unstack") }}</button>
    </div>

    <div v-if="model" class="stack-banner__row">
      <span class="stack-banner__text">
        {{ restackText }}
        <template v-if="model.kind === 'parent_merged'"> {{ t("stacks.banner.oldCommits", model.layer.branch) }}</template>
      </span>
      <button v-if="canPreview" class="stack-banner__btn stack-banner__btn--primary" @click="preview">
        {{ t("stacks.banner.preview") }}
      </button>
      <button v-if="canUnstackLayer" class="stack-banner__btn" @click="unstack(model.layer.branch)">
        {{ t("stacks.menu.unstack") }}
      </button>
      <button class="stack-banner__btn" @click="stacks.later()">{{ t("stacks.banner.later") }}</button>
    </div>

    <div v-if="after" class="stack-banner__after">
      <div v-if="retargetText" class="stack-banner__row">
        <span class="stack-banner__text">{{ retargetText }}</span>
        <button v-if="after.retarget.state === 'failed'" class="stack-banner__btn" @click="stacks.retryRetarget()">
          {{ t("stacks.after.retry") }}
        </button>
      </div>
      <div v-if="switchText" class="stack-banner__row stack-banner__row--warn">
        <span class="stack-banner__text">{{ switchText }}</span>
      </div>
      <div v-if="after.deleteOffer" class="stack-banner__row">
        <button class="stack-banner__btn" @click="actions.deleteMergedParent()">
          {{ t("stacks.after.deleteParent", after.deleteOffer) }}
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
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: var(--font-size-xs);
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
  flex: 1 1 100%;
  color: var(--color-text);
}
.stack-banner__after {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-right: var(--space-5);
}
.stack-banner__btn {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.stack-banner__btn:hover {
  background: var(--color-bg-hover, var(--color-bg-secondary));
}
.stack-banner__btn--primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-accent-text, #fff);
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

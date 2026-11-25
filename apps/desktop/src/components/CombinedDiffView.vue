<script setup lang="ts">
/**
 * Combined diff of several commits, full-screen in place of the Git Tree
 * (spec §5.5). A thin container: it loads the diff (`useCombinedDiff`) and
 * the optional AI summary (`useCombinedSummary`) and hands them to
 * `CombinedDiffBody`, which renders.
 */
import { toRef, watch } from "vue";
import CombinedDiffBody from "./CombinedDiffBody.vue";
import { useI18n } from "../composables/useI18n";
import { useCombinedDiff, type CombinedRequest } from "../composables/useCombinedDiff";
import { useCombinedSummary } from "../composables/useCombinedSummary";
import { useCommitSelection } from "../composables/useCommitSelection";
import type { DiffMode } from "../utils/diffMode";

const { locale } = useI18n();

const props = defineProps<{
  cwd: string;
  request: CombinedRequest;
  diffMode: DiffMode;
}>();

const emit = defineEmits<{
  close: [];
  "select-commit": [hash: string];
  "update:diffMode": [mode: DiffMode];
}>();

const { data, entries, loading, error, reload } = useCombinedDiff(toRef(props, "cwd"), toRef(props, "request"));

const { available, summary, loading: summarizing, error: summaryErr, generate, reset } = useCombinedSummary();
// A new/reloaded diff makes a previous summary stale.
watch(data, () => reset());
function summarize() {
  if (data.value) void generate(data.value, locale.value);
}

// A jump to one of its commits also makes it the Git Tree's ⇧-range anchor,
// as a plain click on that row would (the multi-selection stays). Set here,
// in this lazy chunk, so the selection code stays out of the main bundle.
const graphSelection = useCommitSelection(toRef(props, "cwd"));
function jumpToCommit(hash: string) {
  graphSelection.setAnchor(hash);
  emit("select-commit", hash);
}

// Esc is App's: `onGlobalKeydown` closes this view after any panel on top
// of it (`utils/combinedEsc.ts`).
</script>

<template>
  <CombinedDiffBody
    :request="request"
    :diff-mode="diffMode"
    :data="data"
    :entries="entries"
    :loading="loading"
    :error="error"
    :ai-available="available"
    :summary="summary"
    :summarizing="summarizing"
    :summary-error="!!summaryErr"
    @close="emit('close')"
    @select-commit="jumpToCommit"
    @update:diff-mode="emit('update:diffMode', $event)"
    @retry="reload()"
    @summarize="summarize"
  />
</template>

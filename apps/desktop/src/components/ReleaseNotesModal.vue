<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { gitListTags, getGitBranches, gitExec, type GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import {
  useReleaseNotes,
  FROM_PROJECT_START,
  getReleaseNotesDraft,
  isGeneratingReleaseNotes,
} from "../composables/useReleaseNotes";
import BaseModal from "./BaseModal.vue";
import AiTemplateMenu from "./AiTemplateMenu.vue";
import AiSparkle from "./AiSparkle.vue";
import { getTemplateLang, useAiTemplates } from "../composables/useAiTemplates";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { t } = useI18n();
const { generateDraft } = useReleaseNotes();

// Active AI template (picked from the Generate split button), shown on the button.
const { activeTemplate } = useAiTemplates("releaseNotes", () => props.cwd);

// Refs + generated text live in the per-repo draft, so they survive closing
// the modal (and a generation still running when it closes).
const draft = computed(() => getReleaseNotesDraft(props.cwd));
const isGenerating = computed(() => isGeneratingReleaseNotes(props.cwd));
const copied = ref(false);

// Ref pickers (tags + branches) for the from/to selects.
const branches = ref<GitBranch[]>([]);
const tagNames = ref<string[]>([]);
const localBranchNames = computed(() =>
  branches.value.filter((b) => !b.isRemote).map((b) => b.name),
);
const remoteBranchNames = computed(() =>
  branches.value.filter((b) => b.isRemote).map((b) => b.name),
);

/** Two short/long SHAs refer to the same commit if either is a prefix of the other. */
function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
}

/**
 * Closest local branch strictly *behind* HEAD (an ancestor with ≥1 commit
 * between it and HEAD) — the branch HEAD most recently grew out of. Mirrors the
 * "latest tag before HEAD" logic, for repos with no tags. Returns "" if none.
 */
async function previousBranch(localNames: string[]): Promise<string> {
  const checked = await Promise.all(
    localNames.map(async (name) => {
      const anc = await gitExec(props.cwd, ["merge-base", "--is-ancestor", name, "HEAD"]).catch(() => null);
      if (!anc || anc.exitCode !== 0) return null; // not an ancestor of HEAD
      const cnt = await gitExec(props.cwd, ["rev-list", "--count", `${name}..HEAD`]).catch(() => null);
      const n = cnt && cnt.exitCode === 0 ? parseInt((cnt.stdout ?? "").trim(), 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) return null; // n<=0 ⇒ same commit as HEAD (e.g. current branch)
      return { name, n };
    }),
  );
  const valid = checked.filter((x): x is { name: string; n: number } => x !== null);
  valid.sort((a, b) => a.n - b.n); // closest to HEAD first
  return valid[0]?.name ?? "";
}

const { settings } = useSettings();

onMounted(async () => {
  // Reopened: keep the refs the user had picked (no default to resolve).
  const hasRefs = !!draft.value.from;
  const [, tags, headSha] = await Promise.all([
    getGitBranches(props.cwd, settings.value.defaultBranch)
      .then((b) => { branches.value = b; })
      .catch(() => { branches.value = []; }),
    gitListTags(props.cwd).catch(() => []),
    hasRefs
      ? ""
      : gitExec(props.cwd, ["rev-parse", "HEAD"])
          .then((r) => (r.exitCode === 0 ? (r.stdout ?? "").trim() : ""))
          .catch(() => ""),
  ]);

  // Newest tag first (max tagger/committer date).
  const sorted = [...tags].sort((a, b) => b.date.localeCompare(a.date));
  tagNames.value = sorted.map((tg) => tg.name);

  if (hasRefs) return;

  if (sorted.length) {
    // Default "from" = newest tag that is NOT on HEAD — otherwise `tag..HEAD`
    // would be an empty range. Fall back to the newest tag if every tag is on HEAD.
    const beforeHead = headSha
      ? sorted.find((tg) => !sameCommit(tg.hash, headSha))
      : undefined;
    draft.value.from = (beforeHead ?? sorted[0])?.name ?? "";
  } else {
    // No tags: fall back to the closest ancestor branch, then to the very first
    // commit ("from the project creation").
    const prev = await previousBranch(localBranchNames.value);
    draft.value.from = prev || FROM_PROJECT_START;
  }
});

function runGenerate() {
  copied.value = false;
  void generateDraft(props.cwd, { locale: getTemplateLang("releaseNotes", props.cwd) });
}

async function copy() {
  if (!draft.value.markdown) return;
  try {
    await navigator.clipboard.writeText(draft.value.markdown);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* clipboard perms may be denied */ }
}
</script>

<template>
  <BaseModal
    :title="t('dashboard.releaseNotesTitle')"
    size="2x"
    @close="emit('close')"
  >
    <p class="rn-desc">{{ t('dashboard.releaseNotesDesc') }}</p>
    <div class="rn-refs">
      <label class="rn-field">
        <span>{{ t('dashboard.releaseNotesFrom') }}</span>
        <select v-model="draft.from" class="rn-input mono" :disabled="isGenerating">
          <option value="HEAD">HEAD</option>
          <option :value="FROM_PROJECT_START">{{ t('dashboard.releaseNotesFromCreation') }}</option>
          <optgroup v-if="tagNames.length" :label="t('dashboard.releaseNotesTags')">
            <option v-for="tn in tagNames" :key="`f-${tn}`" :value="tn">{{ tn }}</option>
          </optgroup>
          <optgroup v-if="localBranchNames.length" :label="t('dashboard.releaseNotesBranches')">
            <option v-for="b in localBranchNames" :key="`f-${b}`" :value="b">{{ b }}</option>
          </optgroup>
          <optgroup v-if="remoteBranchNames.length" :label="t('dashboard.releaseNotesRemoteBranches')">
            <option v-for="b in remoteBranchNames" :key="`f-${b}`" :value="b">{{ b }}</option>
          </optgroup>
        </select>
      </label>
      <span class="rn-sep">..</span>
      <label class="rn-field">
        <span>{{ t('dashboard.releaseNotesTo') }}</span>
        <select v-model="draft.to" class="rn-input mono" :disabled="isGenerating">
          <option value="HEAD">HEAD</option>
          <optgroup v-if="tagNames.length" :label="t('dashboard.releaseNotesTags')">
            <option v-for="tn in tagNames" :key="`t-${tn}`" :value="tn">{{ tn }}</option>
          </optgroup>
          <optgroup v-if="localBranchNames.length" :label="t('dashboard.releaseNotesBranches')">
            <option v-for="b in localBranchNames" :key="`t-${b}`" :value="b">{{ b }}</option>
          </optgroup>
          <optgroup v-if="remoteBranchNames.length" :label="t('dashboard.releaseNotesRemoteBranches')">
            <option v-for="b in remoteBranchNames" :key="`t-${b}`" :value="b">{{ b }}</option>
          </optgroup>
        </select>
      </label>
      <div class="rn-split">
        <button
          type="button"
          class="btn btn--ai rn-ai-btn rn-split-main"
          :disabled="isGenerating || !draft.from.trim() || !draft.to.trim()"
          @click="runGenerate"
        >
          <span v-if="isGenerating" class="rn-ai-label ai-loading">
            <span class="rn-spinner" aria-hidden="true"></span>
            {{ t('pr.create.aiGenerating') }}
          </span>
          <span v-else class="rn-ai-label">
            <AiSparkle :size="13" />
            {{ t('dashboard.releaseNotesGenerate') }}
            <span v-if="activeTemplate" class="rn-active-tpl">· {{ activeTemplate.name }}</span>
          </span>
        </button>
        <AiTemplateMenu
          kind="releaseNotes"
          :cwd="cwd"
          :disabled="isGenerating"
          chevron-class="btn btn--ai rn-ai-btn rn-split-chevron"
          @manage="emit('close')"
        />
      </div>
    </div>
    <p v-if="draft.error" class="rn-error">{{ draft.error }}</p>
    <textarea
      v-model="draft.markdown"
      class="rn-textarea mono"
      :disabled="isGenerating"
      rows="22"
      spellcheck="false"
      :placeholder="t('dashboard.releaseNotesPlaceholder')"
    />
    <template #footer>
      <button class="bm-btn bm-btn--ghost" :disabled="!draft.markdown" @click="copy">
        {{ copied ? t('dashboard.releaseNotesCopied') : t('dashboard.releaseNotesCopy') }}
      </button>
      <button class="bm-btn bm-btn--primary" @click="emit('close')">{{ t('common.close') }}</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.rn-desc { color: var(--color-text-muted); font-size: var(--font-size-sm); margin: 0 0 var(--space-6); }
.rn-refs {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.rn-field { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--font-size-xs); color: var(--color-text-muted); }
.rn-sep { padding-bottom: var(--space-3); color: var(--color-text-muted); }


.rn-input,
.rn-textarea {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-sm);
  font-family: inherit;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  resize: vertical;
}

.rn-input:focus,
.rn-textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.rn-input:disabled,
.rn-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.rn-field .rn-input { min-width: 140px; }
select.rn-input {
  cursor: pointer;
  max-width: 220px;
  height: 32px;
  padding-top: 0;
  padding-bottom: 0;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right var(--space-3) center;
  padding-right: var(--space-8);
}

.rn-error {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-danger, #ef4444);
  background: var(--color-danger-soft, rgba(239, 68, 68, 0.06));
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--color-danger, #ef4444);
}

/* Generate split button — the PR view's AI button (.btn--ai + sparkle),
   taller to line up with the ref selects. The chevron lives in
   AiTemplateMenu, styled from here via :deep(). */
.rn-split {
  display: inline-flex;
  margin-left: auto;
}
.rn-split :deep(.btn.btn--ai.rn-ai-btn) {
  height: 32px;
  min-height: 32px;
  padding: 0 12px;
  font-size: var(--font-size-sm);
  border-radius: var(--radius-sm);
  color: var(--color-text);
}
.rn-split :deep(.btn.btn--ai.rn-ai-btn:hover:not(:disabled)) {
  color: var(--color-ai-text);
  transform: none;
  background:
    linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%) padding-box,
    linear-gradient(135deg, var(--color-accent) 0%, #c084fc 50%, var(--color-accent) 100%) border-box;
}
.rn-split .btn.btn--ai.rn-split-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.rn-split :deep(.btn.btn--ai.rn-split-chevron) {
  padding: 0 8px;
  margin-left: -1px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.rn-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.rn-active-tpl {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}
.rn-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: rn-spin 0.7s linear infinite;
}
@keyframes rn-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .rn-spinner { animation: none; }
}
</style>


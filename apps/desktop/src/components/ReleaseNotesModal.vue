<script setup lang="ts">
import { ref, computed, onMounted, inject } from "vue";
import { gitListTags, getGitBranches, gitExec, type GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import { useReleaseNotes, FROM_PROJECT_START } from "../composables/useReleaseNotes";
import BaseModal from "./BaseModal.vue";
import { OPEN_SETTINGS_KEY } from "../composables/branchPickerBridge";
import { useReleaseNoteTemplates, getActiveTemplateId } from "../composables/useReleaseNoteTemplates";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { t, locale } = useI18n();
const {
  isGenerating,
  generate: generateReleaseNotes,
  lastError,
} = useReleaseNotes();

const openSettings = inject(OPEN_SETTINGS_KEY, undefined);
const { templates, activate } = useReleaseNoteTemplates(() => props.cwd);
const selectedTemplateId = ref<string | null>(null);

function saveTemplate() {
  activate(selectedTemplateId.value);
}

function goToSettings() {
  emit("close");
  if (openSettings) {
    openSettings("releaseNotes");
  }
}

const from = ref("");
const to = ref("HEAD");
const markdown = ref("");
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
  selectedTemplateId.value = getActiveTemplateId(props.cwd);
  const [, tags, headSha] = await Promise.all([
    getGitBranches(props.cwd, settings.value.defaultBranch)
      .then((b) => { branches.value = b; })
      .catch(() => { branches.value = []; }),
    gitListTags(props.cwd).catch(() => []),
    gitExec(props.cwd, ["rev-parse", "HEAD"])
      .then((r) => (r.exitCode === 0 ? (r.stdout ?? "").trim() : ""))
      .catch(() => ""),
  ]);

  // Newest tag first (max tagger/committer date).
  const sorted = [...tags].sort((a, b) => b.date.localeCompare(a.date));
  tagNames.value = sorted.map((tg) => tg.name);

  if (sorted.length) {
    // Default "from" = newest tag that is NOT on HEAD — otherwise `tag..HEAD`
    // would be an empty range. Fall back to the newest tag if every tag is on HEAD.
    const beforeHead = headSha
      ? sorted.find((tg) => !sameCommit(tg.hash, headSha))
      : undefined;
    from.value = (beforeHead ?? sorted[0])?.name ?? "";
  } else {
    // No tags: fall back to the closest ancestor branch, then to the very first
    // commit ("from the project creation").
    const prev = await previousBranch(localBranchNames.value);
    from.value = prev || FROM_PROJECT_START;
  }
});

async function runGenerate() {
  copied.value = false;
  try {
    markdown.value = await generateReleaseNotes(
      props.cwd,
      from.value,
      to.value,
      { locale: locale.value },
    );
  } catch {
    markdown.value = "";
  }
}

async function copy() {
  if (!markdown.value) return;
  try {
    await navigator.clipboard.writeText(markdown.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* clipboard perms may be denied */ }
}
</script>

<template>
  <BaseModal
    :title="t('dashboard.releaseNotesTitle')"
    size="lg"
    @close="emit('close')"
  >
    <p class="rn-desc">{{ t('dashboard.releaseNotesDesc') }}</p>
    <div class="rn-refs">
      <label class="rn-field">
        <span>{{ t('dashboard.releaseNotesFrom') }}</span>
        <select v-model="from" class="rn-input mono">
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
        <select v-model="to" class="rn-input mono">
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
      <label class="rn-field">
        <span class="rn-template-label-container">
          <span>{{ t('dashboard.releaseNotesTemplate') }}</span>
          <button class="rn-settings-link" @click="goToSettings" :title="t('dashboard.releaseNotesTemplateShortcut')">
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
            </svg>
          </button>
        </span>
        <select v-model="selectedTemplateId" class="rn-input" @change="saveTemplate">
          <option :value="null">{{ t('settings.ai.releaseNotes.defaultTemplate') }}</option>
          <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
        </select>
      </label>
      <button
        class="bm-btn bm-btn--primary rn-btn-sm rn-generate"
        :class="{ 'rn-generate--loading': isGenerating }"
        :disabled="isGenerating || !from.trim() || !to.trim()"
        @click="runGenerate"
      >
        <span class="rn-generate-label">{{ t('dashboard.releaseNotesGenerate') }}</span>
        <svg v-if="isGenerating" class="rn-generate-loader" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3" />
          <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <p v-if="lastError" class="rn-error">{{ lastError }}</p>
    <textarea
      v-model="markdown"
      class="rn-textarea mono"
      rows="14"
      spellcheck="false"
      :placeholder="t('dashboard.releaseNotesPlaceholder')"
    />
    <template #footer>
      <button class="bm-btn bm-btn--ghost" :disabled="!markdown" @click="copy">
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

.rn-btn-sm {
  height: 32px;
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  line-height: 1;
}

/* Loader swap: keep the label in the DOM (reserves width across states and
   locales) but hide it while generating, with the sparkle centred on top. */
.rn-generate { position: relative; }
.rn-generate--loading .rn-generate-label { visibility: hidden; }
.rn-generate-loader {
  position: absolute;
  top: 50%;
  left: 50%;
  margin: -7px 0 0 -7px; /* half the 14px box — keeps it centred under rotation */
  animation: rn-spin 0.7s linear infinite;
}

@keyframes rn-spin {
  to { transform: rotate(360deg); }
}

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

.rn-template-label-container {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.rn-settings-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}

.rn-settings-link:hover {
  opacity: 1;
  color: var(--color-accent);
}
</style>


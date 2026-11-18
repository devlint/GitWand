<script setup lang="ts">
import { IS_MAC } from "../utils/platform";
/**
 * "New issue" (#301) — a modal over whatever the user was looking at, so the
 * commit or the diff stays on screen behind it. All state lives in
 * `useCreateIssue` (provided by App.vue); this component renders it.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import BaseModal from "./BaseModal.vue";
import RemoteImagesNotice from "./RemoteImagesNotice.vue";
import { CREATE_ISSUE_KEY } from "../composables/useCreateIssue";
import { renderMarkdown, safeHtml, hasBlockedRemoteImages } from "../composables/useSafeHtml";
import { useI18n } from "../composables/useI18n";
import { ISSUE_TITLE_MAX } from "../utils/issuePrefill";
import { openExternalUrl } from "../utils/backend";

const { t } = useI18n();
const form = inject(CREATE_ISSUE_KEY)!;
type AskConfirm = (o: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
// The app's in-app confirm (App.vue provides it); native confirm() only as a fallback.
const askConfirm = inject<AskConfirm>("askConfirm", async (o) => window.confirm(o.message));

const tab = ref<"write" | "preview">("write");
const submitKeys = IS_MAC ? "⌘Enter" : "Ctrl+Enter";
const imagesShown = ref(false);
const titleInput = ref<HTMLInputElement | null>(null);

const showForm = computed(() => !form.loading.value && !form.targetsFailed.value && !!form.repo.value);

// Focus the title once the form is on screen (targets are read first).
watch(showForm, async (shown) => {
  if (!shown) return;
  await nextTick();
  titleInput.value?.focus();
}, { immediate: true });

// Rendered only while the Preview tab is shown: no markdown + sanitiser pass
// on every keystroke of a long body.
const preview = computed(() => {
  if (tab.value !== "preview") return "";
  const src = form.body.value;
  if (!src.trim()) return `<p class="ci-preview-empty">${t("createIssue.previewEmpty")}</p>`;
  return safeHtml(renderMarkdown(src, { allowRemoteImages: imagesShown.value }), {
    allowRemoteImages: imagesShown.value,
  });
});
const imagesBlocked = computed(() => hasBlockedRemoteImages(preview.value));

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

async function onCancel() {
  if (form.submitting.value) return;
  if (form.dirty.value) {
    const discard = await askConfirm({
      title: t("createIssue.discardTitle"),
      message: t("createIssue.discardConfirm"),
      confirmLabel: t("createIssue.discard"),
      danger: true,
    });
    // A create may have started while the question was open (⌘Enter):
    // closing now would drop its answer and the notice that it was created.
    if (!discard || form.submitting.value) return;
  }
  form.close();
}

function onKeydown(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey)) return;
  // App shortcuts stay outside the form: ⌘Z here undoes typing, not the last
  // git operation; ⌘⇧I does not reopen the form.
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    void form.submit();
  }
}

/** The target's issue list, to see whether a timed-out create went through. */
function openIssuesPage() {
  const target = form.targets.value.find((x) => x.repo === form.repo.value);
  if (target?.htmlUrl) void openExternalUrl(`${target.htmlUrl}/issues`);
}

function onMilestone(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  form.milestone.value = v === "" ? null : Number(v);
}
</script>

<template>
  <BaseModal
    :title="t('createIssue.title')"
    :subtitle="form.repo.value ?? ''"
    size="lg"
    :auto-focus="false"
    @close="onCancel"
  >
    <div class="ci" @keydown="onKeydown">
      <p v-if="form.loading.value" class="ci-status">{{ t("createIssue.loading") }}</p>
      <template v-else-if="form.targetsFailed.value">
        <p class="ci-status ci-status--error" role="alert">{{ t("createIssue.targetsFailed") }}</p>
        <p v-if="form.targetsError.value" class="ci-status ci-detail">{{ form.targetsError.value }}</p>
      </template>
      <p v-else-if="!form.repo.value" class="ci-status" role="alert">
        {{ t("createIssue.noTarget") }}
      </p>

      <template v-if="showForm">
        <fieldset v-if="form.targets.value.length > 1" class="ci-targets">
          <legend class="ci-label">{{ t("createIssue.target") }}</legend>
          <label
            v-for="target in form.targets.value"
            :key="target.repo"
            class="ci-target"
            :class="{ 'ci-target--off': !target.hasIssues }"
          >
            <input
              type="radio"
              name="ci-target"
              :value="target.repo"
              :checked="form.repo.value === target.repo"
              :disabled="!target.hasIssues || form.submitting.value || form.outcomeUnknown.value"
              @change="form.setRepo(target.repo)"
            />
            <span class="ci-target-repo">{{ target.repo }}</span>
            <span class="ci-target-kind">
              {{ target.isOrigin ? t("createIssue.targetOrigin") : t("createIssue.targetParent") }}
            </span>
            <span v-if="!target.hasIssues" class="ci-target-off">{{ t("createIssue.issuesOff") }}</span>
          </label>
        </fieldset>

        <label class="ci-label" for="ci-title">{{ t("createIssue.titleLabel") }}</label>
        <input
          id="ci-title"
          ref="titleInput"
          v-model="form.title.value"
          class="ci-input"
          type="text"
          :maxlength="ISSUE_TITLE_MAX"
          :placeholder="t('createIssue.titlePlaceholder')"
          :disabled="form.submitting.value"
        />

        <div class="ci-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="ci-tab"
            :class="{ 'ci-tab--active': tab === 'write' }"
            :aria-selected="tab === 'write'"
            @click="tab = 'write'"
          >{{ t("createIssue.tabWrite") }}</button>
          <button
            type="button"
            role="tab"
            class="ci-tab"
            :class="{ 'ci-tab--active': tab === 'preview' }"
            :aria-selected="tab === 'preview'"
            @click="tab = 'preview'"
          >{{ t("createIssue.tabPreview") }}</button>
        </div>
        <textarea
          v-show="tab === 'write'"
          v-model="form.body.value"
          class="ci-textarea"
          rows="10"
          :aria-label="t('createIssue.bodyLabel')"
          :placeholder="t('createIssue.bodyPlaceholder')"
          :disabled="form.submitting.value"
        />
        <RemoteImagesNotice v-if="tab === 'preview' && imagesBlocked" @allow="imagesShown = true" />
        <div v-if="tab === 'preview'" class="ci-preview" data-testid="ci-preview" v-html="preview" />

        <div v-if="form.labelOptions.value.length" class="ci-group">
          <span class="ci-label">{{ t("createIssue.labels") }}</span>
          <div class="ci-chips">
            <button
              v-for="label in form.labelOptions.value"
              :key="label.name"
              type="button"
              class="ci-chip"
              :aria-pressed="form.labels.value.includes(label.name)"
              :disabled="form.submitting.value"
              :title="label.description ?? ''"
              @click="form.labels.value = toggle(form.labels.value, label.name)"
            >
              <span class="ci-chip-dot" :style="{ background: `#${label.color || '888'}` }" aria-hidden="true" />
              {{ label.name }}
            </button>
          </div>
        </div>

        <div v-if="form.assigneeOptions.value.length" class="ci-group">
          <span class="ci-label">{{ t("createIssue.assignees") }}</span>
          <div class="ci-chips">
            <button
              v-for="user in form.assigneeOptions.value"
              :key="user.login"
              type="button"
              class="ci-chip"
              :aria-pressed="form.assignees.value.includes(user.login)"
              :disabled="form.submitting.value"
              @click="form.assignees.value = toggle(form.assignees.value, user.login)"
            >@{{ user.login }}</button>
          </div>
        </div>

        <div v-if="form.milestoneOptions.value.length" class="ci-group">
          <label class="ci-label" for="ci-milestone">{{ t("createIssue.milestone") }}</label>
          <select
            id="ci-milestone"
            class="ci-select"
            :value="form.milestone.value ?? ''"
            :disabled="form.submitting.value"
            @change="onMilestone"
          >
            <option value="">{{ t("createIssue.noMilestone") }}</option>
            <option v-for="m in form.milestoneOptions.value" :key="m.number" :value="m.number">{{ m.title }}</option>
          </select>
        </div>

        <div v-if="form.outcomeUnknown.value" class="ci-unknown" role="alert">
          <p class="ci-status ci-status--error">{{ t("createIssue.maybeCreated") }}</p>
          <div class="ci-unknown-actions">
            <button type="button" class="bm-btn bm-btn--ghost" @click="openIssuesPage">{{ t("createIssue.checkOnGitHub") }}</button>
            <button type="button" class="bm-btn bm-btn--ghost" @click="form.retryAnyway()">{{ t("createIssue.createAnyway") }}</button>
          </div>
        </div>
        <p v-else-if="form.error.value" class="ci-status ci-status--error" role="alert">{{ form.error.value }}</p>
      </template>
    </div>

    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost" :disabled="form.submitting.value" @click="onCancel">
        {{ t("createIssue.cancel") }}
      </button>
      <button
        v-if="showForm"
        type="button"
        class="bm-btn bm-btn--primary"
        :disabled="!form.canSubmit.value"
        :title="t('createIssue.submitHint', submitKeys)"
        @click="form.submit()"
      >
        {{ form.submitting.value ? t("createIssue.creating") : t("createIssue.create") }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.ci {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 10px);
}
.ci-label {
  font-size: var(--font-size-sm, 12px);
  font-weight: 600;
  color: var(--color-text-muted);
}
.ci-input,
.ci-textarea,
.ci-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
}
.ci-textarea {
  resize: vertical;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--font-size-sm, 12px);
}
.ci-tabs {
  display: flex;
  gap: 4px;
}
.ci-tab {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
}
.ci-tab--active {
  border-color: var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
}
.ci-preview {
  min-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow-wrap: anywhere;
}
.ci-preview :deep(ul),
.ci-preview :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.ci-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ci-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 120px;
  overflow-y: auto;
}
.ci-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-size-sm, 12px);
  cursor: pointer;
}
.ci-chip[aria-pressed="true"] {
  border-color: var(--color-accent);
  background: var(--color-accent-soft, var(--color-bg-secondary));
}
.ci-chip-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.ci-targets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: none;
}
.ci-target {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.ci-target--off {
  opacity: 0.6;
  cursor: not-allowed;
}
.ci-target-repo {
  font-family: var(--font-mono, ui-monospace, monospace);
}
.ci-target-kind,
.ci-target-off {
  font-size: var(--font-size-sm, 12px);
  color: var(--color-text-muted);
}
.ci-status {
  margin: 0;
  color: var(--color-text-muted);
}
.ci-detail {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--font-size-sm, 12px);
  overflow-wrap: anywhere;
}
.ci-unknown-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.ci-status--error {
  color: var(--color-danger, #d73a4a);
}
</style>

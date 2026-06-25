<script setup lang="ts">
/**
 * PrCreateView.vue
 *
 * Full-width Pull Request creation page rendered in <main> when the user
 * clicks "+ Nouvelle PR" in the PR sidebar.
 *
 * - Full-bleed root (takes theme bg), content centered inside
 * - Markdown RTE for the description (toolbar + Write/Preview tabs)
 * - Confirmation modal (not native confirm()) when switching templates
 *   on a non-empty body
 */
import { computed, inject, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { PR_PANEL_KEY, type PrPanelState } from "../composables/usePrPanel";
import { renderMarkdown, safeHtml } from "../composables/useSafeHtml";
import { ghListReviewerCandidates, type GitBranch, type ReviewerCandidate } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { useAIProvider } from "../composables/useAIProvider";
import { usePrDescription } from "../composables/usePrDescription";
import { loadSettings } from "../composables/useSettings";
import AiSparkle from "./AiSparkle.vue";

const props = defineProps<{
  currentBranch: string;
  branches: GitBranch[];
  cwd: string;
}>();

const emit = defineEmits<{ (e: "cancel"): void }>();

const p = inject<PrPanelState>(PR_PANEL_KEY)!;
const { t, locale } = useI18n();
const ai = useAIProvider();
const { isGenerating: isGeneratingPrDescription, generate: generatePrDescription } = usePrDescription();
const aiPrError = ref<string | null>(null);

async function generateWithAI() {
  aiPrError.value = null;
  const hasContent = p.newPrTitle.value.trim() || p.newPrBody.value.trim();
  if (hasContent && !confirm(t("pr.create.aiReplaceConfirm"))) return;
  try {
    // PR language: "english" (default) forces English; "ui" follows the app locale.
    const prLang = loadSettings().prAiLanguage === "ui" ? locale.value : "en";
    const result = await generatePrDescription(
      props.cwd,
      props.currentBranch,
      p.newPrBase.value,
      { locale: prLang },
    );
    if (result.title) p.newPrTitle.value = result.title;
    if (result.body) p.newPrBody.value = result.body;
  } catch (err: any) {
    aiPrError.value = err?.message ?? String(err);
  }
}

// Fork-target radio options: upstream parent first, then the fork (origin).
const forkTargets = computed(() => {
  const fi = p.forkInfo.value;
  if (!fi?.isFork || !fi.parent) return [];
  return [
    { repo: fi.parent, badge: t("pr.create.targetUpstream") },
    { repo: fi.origin, badge: t("pr.create.targetFork") },
  ];
});

// Strip the remote prefix from a remote-tracking ref ("origin/feat/x" → "feat/x").
const bareRemoteName = (ref: string) => ref.replace(/^[^/]+\//, "");

// ─── Base branch candidates ─────────────────────────────
const baseCandidates = computed<string[]>(() => {
  const locals = new Set<string>();
  const remoteOnly: string[] = [];
  for (const b of props.branches) {
    if (!b.isRemote && b.name !== props.currentBranch) locals.add(b.name);
  }
  for (const b of props.branches) {
    if (b.isRemote) {
      const bare = bareRemoteName(b.name);
      if (!locals.has(bare) && bare !== props.currentBranch) remoteOnly.push(bare);
    }
  }
  return [...Array.from(locals).sort(), ...Array.from(new Set(remoteOnly)).sort()];
});

const defaultBase = computed<string>(() => {
  const c = baseCandidates.value;
  for (const name of ["main", "master", "develop", "dev"]) if (c.includes(name)) return name;
  return c[0] ?? "main";
});

watch(defaultBase, (v) => {
  if (!p.newPrBase.value.trim() && v) p.newPrBase.value = v;
}, { immediate: true });

watch(() => props.currentBranch, (branch) => {
  if (!p.newPrTitle.value.trim() && branch) p.newPrTitle.value = suggestTitle(branch);
}, { immediate: true });

function suggestTitle(branch: string): string {
  const parts = branch.split("/");
  if (parts.length >= 2) {
    const prefix = parts[0];
    const rest = parts.slice(1).join("/").replace(/[-_]+/g, " ");
    return `${cap(prefix)}: ${rest}`;
  }
  return cap(branch.replace(/[-_]+/g, " "));
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Templates with modal confirmation ──────────────────
interface Template { key: string; label: string; body: string; }
const templates = computed<Template[]>(() => [
  { key: "feat",  label: t("pr.create.templateFeat"),  body: t("pr.create.templateFeatBody") },
  { key: "fix",   label: t("pr.create.templateFix"),   body: t("pr.create.templateFixBody") },
  { key: "chore", label: t("pr.create.templateChore"), body: t("pr.create.templateChoreBody") },
  { key: "docs",  label: t("pr.create.templateDocs"),  body: t("pr.create.templateDocsBody") },
]);

const pendingTemplate = ref<Template | null>(null);

function applyTemplate(tpl: Template) {
  if (!p.newPrBody.value.trim()) {
    p.newPrBody.value = tpl.body;
    return;
  }
  pendingTemplate.value = tpl;
}
function confirmTemplate() {
  if (pendingTemplate.value) p.newPrBody.value = pendingTemplate.value.body;
  pendingTemplate.value = null;
}
function cancelTemplate() { pendingTemplate.value = null; }

// ─── Markdown RTE ───────────────────────────────────────
const editorTab = ref<"write" | "preview">("write");
const bodyTextarea = useTemplateRef<HTMLTextAreaElement>("bodyTextarea");

function surroundSelection(before: string, after: string = before, placeholder: string = "") {
  const ta = bodyTextarea.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = p.newPrBody.value;
  const selected = value.slice(start, end) || placeholder;
  const newVal = value.slice(0, start) + before + selected + after + value.slice(end);
  p.newPrBody.value = newVal;
  nextTick(() => {
    ta.focus();
    const caretStart = start + before.length;
    const caretEnd = caretStart + selected.length;
    ta.setSelectionRange(caretStart, caretEnd);
  });
}

function prefixLines(prefix: string) {
  const ta = bodyTextarea.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = p.newPrBody.value;
  // Expand selection to full lines
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const endIdx = lineEnd === -1 ? value.length : lineEnd;
  const block = value.slice(lineStart, endIdx);
  const newBlock = block.split("\n").map((l) => prefix + l).join("\n");
  p.newPrBody.value = value.slice(0, lineStart) + newBlock + value.slice(endIdx);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(lineStart, lineStart + newBlock.length);
  });
}

function insertLink() {
  const ta = bodyTextarea.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = p.newPrBody.value;
  const selected = value.slice(start, end) || "text";
  const snippet = `[${selected}](url)`;
  p.newPrBody.value = value.slice(0, start) + snippet + value.slice(end);
  nextTick(() => {
    ta.focus();
    const urlStart = start + snippet.length - 4; // position "url"
    ta.setSelectionRange(urlStart, urlStart + 3);
  });
}

function insertCodeBlock() {
  const ta = bodyTextarea.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = p.newPrBody.value;
  const selected = value.slice(start, end) || "code";
  const snippet = "\n```\n" + selected + "\n```\n";
  p.newPrBody.value = value.slice(0, start) + snippet + value.slice(end);
  nextTick(() => {
    ta.focus();
    const s = start + 5;
    ta.setSelectionRange(s, s + selected.length);
  });
}

// ─── Markdown preview ───────────────────────────────────
// Markdown rendering is delegated to the shared `useSafeHtml` composable
// (markdown-it + DOMPurify). We only add the component-specific empty
// state here. The rendered HTML is fed to `v-html` via `safeHtml()`,
// which also re-sanitizes for defense in depth.
const bodyPreview = computed(() => {
  const src = p.newPrBody.value;
  if (!src.trim()) {
    return `<p class="pcv-preview-empty">${t("pr.create.previewEmpty")}</p>`;
  }
  return renderMarkdown(src);
});

// ─── Validation ─────────────────────────────────────────
const canSubmit = computed(
  () =>
    p.newPrTitle.value.trim().length > 0 &&
    p.newPrBase.value.trim().length > 0 &&
    p.newPrBase.value.trim() !== props.currentBranch &&
    isCurrentBranchPublished.value &&
    !p.isCreating.value,
);
const baseIsSameAsHead = computed(() => p.newPrBase.value.trim() === props.currentBranch);

// The current branch is "published" when it has a configured upstream or a
// remote-tracking branch with the same name exists. When it doesn't, creating
// the PR is blocked — the branch must be pushed first.
const isCurrentBranchPublished = computed<boolean>(() => {
  const cur = props.currentBranch;
  if (!cur) return true; // unknown branch — don't nag
  const local = props.branches.find((b) => !b.isRemote && b.name === cur);
  if (local?.upstream) return true;
  return props.branches.some((b) => b.isRemote && bareRemoteName(b.name) === cur);
});

async function onSubmit() {
  if (!canSubmit.value) return;
  await p.createPr();
}

function onCancel() {
  p.showCreateForm.value = false;
  emit("cancel");
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    onSubmit();
  }
}

const titleLen = computed(() => p.newPrTitle.value.length);

function onBaseInput(e: Event) {
  p.newPrBase.value = (e.target as HTMLInputElement).value;
}

// ─── Reviewers ──────────────────────────────────────────
// Tag-style input with autocomplete: candidates are fetched from
// gh api /repos/:owner/:repo/assignees on mount, then filtered locally
// as the user types. Enter/Tab on the active suggestion adds it.
const reviewerInput = ref("");
const reviewerCandidates = ref<ReviewerCandidate[]>([]);
const reviewerCandidatesLoading = ref(false);
const reviewerSuggestOpen = ref(false);
const reviewerActiveIdx = ref(0);

onMounted(async () => {
  if (!props.cwd) return;
  reviewerCandidatesLoading.value = true;
  try {
    reviewerCandidates.value = await ghListReviewerCandidates(props.cwd);
  } catch {
    // Silently ignore — autocomplete is optional, manual typing still works.
    reviewerCandidates.value = [];
  } finally {
    reviewerCandidatesLoading.value = false;
  }
});

const filteredCandidates = computed<ReviewerCandidate[]>(() => {
  const q = reviewerInput.value.trim().replace(/^@/, "").toLowerCase();
  const already = new Set(p.newPrReviewers.value.map((r) => r.toLowerCase()));
  return reviewerCandidates.value
    .filter((c) => !already.has(c.login.toLowerCase()))
    .filter((c) => {
      if (!q) return true;
      const login = c.login.toLowerCase();
      const name = (c.name ?? "").toLowerCase();
      return login.includes(q) || name.includes(q);
    })
    .slice(0, 8);
});

watch(reviewerInput, () => {
  reviewerActiveIdx.value = 0;
  reviewerSuggestOpen.value = true;
});

watch(filteredCandidates, (list) => {
  if (reviewerActiveIdx.value >= list.length) reviewerActiveIdx.value = 0;
});

function addReviewer(raw: string) {
  const name = raw.trim().replace(/^@/, "").replace(/,+$/, "");
  if (!name) return;
  if (p.newPrReviewers.value.some((r) => r.toLowerCase() === name.toLowerCase())) return;
  p.newPrReviewers.value = [...p.newPrReviewers.value, name];
}

function pickCandidate(c: ReviewerCandidate) {
  addReviewer(c.login);
  reviewerInput.value = "";
  reviewerActiveIdx.value = 0;
  reviewerSuggestOpen.value = true;
  // refocus input
  nextTick(() => {
    const el = document.getElementById("pcv-reviewer-input") as HTMLInputElement | null;
    el?.focus();
  });
}

function onReviewerKeydown(e: KeyboardEvent) {
  const list = filteredCandidates.value;
  // Navigation when suggestions are visible
  if (reviewerSuggestOpen.value && list.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      reviewerActiveIdx.value = (reviewerActiveIdx.value + 1) % list.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      reviewerActiveIdx.value = (reviewerActiveIdx.value - 1 + list.length) % list.length;
      return;
    }
    if (e.key === "Tab" && reviewerInput.value.trim()) {
      e.preventDefault();
      pickCandidate(list[reviewerActiveIdx.value]);
      return;
    }
    if (e.key === "Enter") {
      // Prefer the highlighted candidate; fall back to raw input.
      e.preventDefault();
      if (list[reviewerActiveIdx.value]) {
        pickCandidate(list[reviewerActiveIdx.value]);
      } else if (reviewerInput.value.trim()) {
        addReviewer(reviewerInput.value);
        reviewerInput.value = "";
      }
      return;
    }
  }

  if (e.key === "Escape") {
    reviewerSuggestOpen.value = false;
    return;
  }

  if (e.key === "Enter" || e.key === "," || e.key === " ") {
    if (reviewerInput.value.trim()) {
      e.preventDefault();
      addReviewer(reviewerInput.value);
      reviewerInput.value = "";
    }
  } else if (e.key === "Backspace" && reviewerInput.value === "" && p.newPrReviewers.value.length > 0) {
    p.newPrReviewers.value = p.newPrReviewers.value.slice(0, -1);
  }
}

function onReviewerFocus() {
  reviewerSuggestOpen.value = true;
}

function onReviewerBlur() {
  // Commit any pending raw text, then close the dropdown after a short delay
  // so click events on suggestions can fire first.
  if (reviewerInput.value.trim()) {
    // Don't auto-add raw text on blur — let users dismiss without surprises
    // (they can use Enter/Tab/comma to add explicitly). Keeping this allows
    // clicking outside to cancel a partial entry.
  }
  setTimeout(() => { reviewerSuggestOpen.value = false; }, 120);
}

function removeReviewer(name: string) {
  p.newPrReviewers.value = p.newPrReviewers.value.filter((r) => r !== name);
}
</script>

<template>
  <div class="pcv-root" @keydown="onKeydown">
    <button class="pcv-close" :title="t('common.close')" :aria-label="t('common.close')" @click="onCancel">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>

    <div class="pcv-container">
      <!-- Hero header -->
      <header class="pcv-hero">
        <div class="pcv-hero-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <line x1="6" y1="9" x2="6" y2="21" />
          </svg>
        </div>
        <div class="pcv-hero-text">
          <h1 class="pcv-title">{{ t("pr.create.title") }}</h1>
          <p class="pcv-subtitle">{{ t("pr.create.subtitle") }}</p>
        </div>
      </header>

      <!-- Messages -->
      <div v-if="p.error.value" class="pcv-msg pcv-msg--error">{{ p.error.value }}</div>

      <!-- Fork target (only when origin is a fork) -->
      <section v-if="forkTargets.length" class="pcv-section">
        <label class="pcv-label">{{ t("pr.create.targetRepoLabel") }}</label>
        <div class="pcv-fork-target">
          <label
            v-for="opt in forkTargets"
            :key="opt.repo"
            class="pcv-fork-opt"
            :class="{ 'pcv-fork-opt--active': p.newPrBaseRepo.value === opt.repo }"
          >
            <input type="radio" :value="opt.repo" v-model="p.newPrBaseRepo.value" />
            <span class="pcv-fork-name mono">{{ opt.repo }}</span>
            <span class="pcv-fork-badge">{{ opt.badge }}</span>
          </label>
        </div>
        <p class="pcv-hint">{{ t("pr.create.targetHint") }}</p>
      </section>

      <!-- Branch flow -->
      <section class="pcv-section">
        <label class="pcv-label" for="pcv-base-input">{{ t("pr.create.branchesLabel") }}</label>
        <div class="pcv-flow">
          <div class="pcv-branch pcv-branch--from">
            <span class="pcv-branch-role">{{ t("pr.create.fromLabel") }}</span>
            <span class="pcv-branch-name mono">{{ currentBranch || "—" }}</span>
          </div>
          <svg class="pcv-arrow" width="22" height="14" viewBox="0 0 22 14" fill="none" aria-hidden="true">
            <path d="M1 7h18m0 0l-5-5m5 5l-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="pcv-branch pcv-branch--to" :class="{ 'pcv-branch--invalid': baseIsSameAsHead }">
            <span class="pcv-branch-role">{{ t("pr.create.intoLabel") }}</span>
            <input
              id="pcv-base-input"
              list="pcv-base-list"
              class="pcv-branch-select"
              :value="p.newPrBase.value"
              @input="onBaseInput"
              :placeholder="defaultBase || 'main'"
              spellcheck="false"
            />
            <datalist id="pcv-base-list">
              <option v-for="name in baseCandidates" :key="name" :value="name" />
            </datalist>
          </div>
        </div>
        <p v-if="baseIsSameAsHead" class="pcv-hint pcv-hint--warn">{{ t("pr.create.sameBranchWarn") }}</p>
        <p v-else class="pcv-hint">{{ t("pr.create.branchesHint") }}</p>
      </section>

      <!-- Title -->
      <section class="pcv-section">
        <div class="pcv-label-row">
          <label class="pcv-label" for="pcv-title-input">{{ t("pr.create.titleLabel") }}</label>
          <button
            v-if="ai.isAvailable.value"
            type="button"
            class="btn btn--ai pcv-ai-btn"
            :disabled="isGeneratingPrDescription || baseIsSameAsHead"
            :title="t('pr.create.aiHint')"
            @click="generateWithAI"
          >
            <span v-if="isGeneratingPrDescription" class="pcv-ai-label">
              <span class="pcv-spinner pcv-spinner--sm" aria-hidden="true"></span>
              {{ t('pr.create.aiGenerating') }}
            </span>
            <span v-else class="pcv-ai-label">
              <AiSparkle :size="13" />
              {{ t('pr.create.aiGenerate') }}
            </span>
          </button>
        </div>
        <input
          id="pcv-title-input"
          v-model="p.newPrTitle.value"
          class="pcv-input pcv-input--title"
          type="text"
          :placeholder="t('pr.create.titlePlaceholder')"
          autofocus
          spellcheck="true"
        />
        <div class="pcv-hint-row">
          <span class="pcv-hint">{{ t("pr.create.titleHint") }}</span>
          <span class="pcv-counter" :class="{ 'pcv-counter--over': titleLen > 72 }">{{ titleLen }}/72</span>
        </div>
        <p v-if="aiPrError" class="pcv-hint pcv-hint--warn">{{ aiPrError }}</p>
      </section>

      <!-- Description RTE -->
      <section class="pcv-section">
        <div class="pcv-label-row">
          <label class="pcv-label" for="pcv-body-input">{{ t("pr.create.bodyLabel") }}</label>
          <div class="pcv-templates">
            <span class="pcv-template-label">{{ t("pr.create.templateLabel") }}</span>
            <div class="pcv-tpl-group" role="group">
              <button
                v-for="tpl in templates"
                :key="tpl.key"
                type="button"
                class="pcv-tpl-btn"
                @click="applyTemplate(tpl)"
              >{{ tpl.label }}</button>
            </div>
          </div>
        </div>

        <!-- Editor chrome: tabs + toolbar -->
        <div class="pcv-editor">
          <div class="pcv-editor-head">
            <div class="pcv-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                class="pcv-tab"
                :class="{ 'pcv-tab--active': editorTab === 'write' }"
                @click="editorTab = 'write'"
              >{{ t("pr.create.tabWrite") }}</button>
              <button
                type="button"
                role="tab"
                class="pcv-tab"
                :class="{ 'pcv-tab--active': editorTab === 'preview' }"
                @click="editorTab = 'preview'"
              >{{ t("pr.create.tabPreview") }}</button>
            </div>

            <div v-if="editorTab === 'write'" class="pcv-toolbar">
              <button type="button" class="pcv-tb-btn" @click="surroundSelection('**', '**', t('pr.create.mdBold'))" :title="t('pr.create.mdBold')"><b>B</b></button>
              <button type="button" class="pcv-tb-btn" @click="surroundSelection('_', '_', t('pr.create.mdItalic'))" :title="t('pr.create.mdItalic')"><i>I</i></button>
              <button type="button" class="pcv-tb-btn" @click="surroundSelection('`', '`', 'code')" :title="t('pr.create.mdCode')">&lt;/&gt;</button>
              <span class="pcv-tb-sep" aria-hidden="true"></span>
              <button type="button" class="pcv-tb-btn" @click="prefixLines('# ')" :title="t('pr.create.mdH1')">H1</button>
              <button type="button" class="pcv-tb-btn" @click="prefixLines('## ')" :title="t('pr.create.mdH2')">H2</button>
              <button type="button" class="pcv-tb-btn" @click="prefixLines('### ')" :title="t('pr.create.mdH3')">H3</button>
              <span class="pcv-tb-sep" aria-hidden="true"></span>
              <button type="button" class="pcv-tb-btn" @click="prefixLines('- ')" :title="t('pr.create.mdUl')">• List</button>
              <button type="button" class="pcv-tb-btn" @click="prefixLines('1. ')" :title="t('pr.create.mdOl')">1. List</button>
              <button type="button" class="pcv-tb-btn" @click="prefixLines('> ')" :title="t('pr.create.mdQuote')">❝</button>
              <span class="pcv-tb-sep" aria-hidden="true"></span>
              <button type="button" class="pcv-tb-btn" @click="insertLink" :title="t('pr.create.mdLink')">🔗</button>
              <button type="button" class="pcv-tb-btn" @click="insertCodeBlock" :title="t('pr.create.mdCodeBlock')">{ }</button>
            </div>
          </div>

          <!-- Write -->
          <textarea
            v-show="editorTab === 'write'"
            id="pcv-body-input"
            ref="bodyTextarea"
            v-model="p.newPrBody.value"
            class="pcv-textarea"
            rows="14"
            :placeholder="t('pr.create.bodyPlaceholder')"
            spellcheck="true"
          />

          <!-- Preview -->
          <div
            v-show="editorTab === 'preview'"
            class="pcv-preview"
            v-html="safeHtml(bodyPreview)"
          />
        </div>
        <p class="pcv-hint">{{ t("pr.create.bodyHint") }}</p>
      </section>

      <!-- Reviewers -->
      <section class="pcv-section">
        <label class="pcv-label" for="pcv-reviewer-input">{{ t("pr.create.reviewersLabel") }}</label>
        <div class="pcv-reviewers" @click="() => ($refs.reviewerInputEl as HTMLInputElement)?.focus()">
          <span
            v-for="name in p.newPrReviewers.value"
            :key="name"
            class="pcv-reviewer-tag"
          >
            <span class="pcv-reviewer-at">@</span>{{ name }}
            <button
              type="button"
              class="pcv-reviewer-remove"
              @click.stop="removeReviewer(name)"
              :aria-label="`Remove ${name}`"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </button>
          </span>
          <input
            id="pcv-reviewer-input"
            ref="reviewerInputEl"
            v-model="reviewerInput"
            class="pcv-reviewer-input"
            type="text"
            :placeholder="p.newPrReviewers.value.length === 0 ? t('pr.create.reviewersPlaceholder') : ''"
            spellcheck="false"
            autocomplete="off"
            @keydown="onReviewerKeydown"
            @focus="onReviewerFocus"
            @blur="onReviewerBlur"
          />

          <!-- Autocomplete dropdown -->
          <div
            v-if="reviewerSuggestOpen && (filteredCandidates.length > 0 || reviewerCandidatesLoading)"
            class="pcv-reviewer-suggest"
            @mousedown.prevent
          >
            <div v-if="reviewerCandidatesLoading && filteredCandidates.length === 0" class="pcv-suggest-empty">
              {{ t("pr.create.reviewersLoading") }}
            </div>
            <button
              v-for="(c, idx) in filteredCandidates"
              :key="c.login"
              type="button"
              class="pcv-suggest-item"
              :class="{ 'pcv-suggest-item--active': idx === reviewerActiveIdx }"
              @click="pickCandidate(c)"
              @mouseenter="reviewerActiveIdx = idx"
            >
              <img
                v-if="c.avatarUrl"
                :src="c.avatarUrl"
                :alt="c.login"
                class="pcv-suggest-avatar"
                referrerpolicy="no-referrer"
              />
              <span v-else class="pcv-suggest-avatar" aria-hidden="true"></span>
              <span class="pcv-suggest-text">
                <span class="pcv-suggest-login">{{ c.login }}</span>
                <span v-if="c.name" class="pcv-suggest-name">{{ c.name }}</span>
              </span>
            </button>
          </div>
        </div>
        <p class="pcv-hint">{{ t("pr.create.reviewersHint") }}</p>
      </section>

      <!-- Options -->
      <section class="pcv-section">
        <label class="pcv-check" :class="{ 'pcv-check--active': p.newPrDraft.value }">
          <input type="checkbox" v-model="p.newPrDraft.value" />
          <span class="pcv-check-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" />
              <path d="M3 12h18" />
              <path d="M3 18h12" />
              <circle cx="19" cy="18" r="2" />
            </svg>
          </span>
          <div class="pcv-check-text">
            <span class="pcv-check-title">{{ t("pr.create.draftLabel") }}</span>
            <span class="pcv-check-hint">{{ t("pr.create.draftHint") }}</span>
          </div>
        </label>
      </section>

      <!-- Footer -->
      <footer class="pcv-footer">
        <div v-if="!isCurrentBranchPublished" class="pcv-note">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h0" />
          </svg>
          <span>{{ t("pr.create.unpublishedBranchWarn") }}</span>
        </div>
        <button
          class="pcv-btn pcv-btn--primary"
          :disabled="!canSubmit"
          @click="onSubmit"
          :title="t('common.ctrlEnter')"
        >
          <span v-if="p.isCreating.value" class="pcv-spinner" aria-hidden="true"></span>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <line x1="6" y1="9" x2="6" y2="21" />
          </svg>
          <span>{{ p.isCreating.value ? t("pr.create.submitting") : (p.newPrDraft.value ? t("pr.create.submitDraft") : t("pr.create.submit")) }}</span>
        </button>
      </footer>
    </div>

    <!-- Template confirmation modal -->
    <Teleport to="body">
      <div v-if="pendingTemplate" class="pcv-modal-backdrop" @click.self="cancelTemplate">
        <div class="pcv-modal" role="dialog" aria-modal="true">
          <div class="pcv-modal-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6" opacity="0.3"/>
              <path d="M12 8v5M12 16h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
          <h2 class="pcv-modal-title">{{ t("pr.create.templateModalTitle") }}</h2>
          <p class="pcv-modal-desc">
            {{ t("pr.create.templateModalDesc", pendingTemplate.label) }}
          </p>
          <div class="pcv-modal-actions">
            <button class="pcv-btn pcv-btn--ghost" @click="cancelTemplate">{{ t("common.cancel") }}</button>
            <button class="pcv-btn pcv-btn--primary" @click="confirmTemplate">
              {{ t("pr.create.templateModalConfirm") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ─── Root: full-bleed, white page bg ────────────────── */
.pcv-root {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--color-bg-secondary);
  overflow-y: auto;
  box-sizing: border-box;
}

.pcv-container {
  max-width: 1240px;
  width: 100%;
  margin: 0 auto;
  /* Extra bottom padding clears the floating AppDock so the in-flow
     footer buttons aren't covered when scrolled to the end. */
  padding: var(--space-9) var(--space-9) calc(var(--space-12) + var(--space-12));
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  min-height: 100%;
  box-sizing: border-box;
}

/* ─── Hero header ────────────────────────────────────── */
.pcv-hero {
  display: flex;
  align-items: flex-start;
  gap: var(--space-5);
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--color-border);
}
.pcv-hero-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}
.pcv-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-left: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  position: sticky;
  top: 20px;
  right: 20px;
  z-index: 6;
}
.pcv-close:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border-color: var(--color-text-muted);
}
.pcv-hero-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.pcv-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  margin: 0;
  color: var(--color-text);
  letter-spacing: -0.015em;
  line-height: 1.15;
}
.pcv-subtitle {
  margin: 0;
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  line-height: 1.5;
  max-width: 640px;
}

/* ─── Sections ───────────────────────────────────────── */
.pcv-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pcv-label {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  letter-spacing: -0.005em;
  line-height: 1.3;
}
.pcv-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pcv-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* ─── Branches flow ──────────────────────────────────── */
.pcv-flow {
  display: flex;
  align-items: stretch;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.pcv-branch {
  flex: 1 1 260px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  min-width: 0;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-branch--from {
  border-left: 3px solid var(--color-accent);
}
.pcv-branch--to {
  border-left: 3px solid var(--color-success);
}
.pcv-branch--invalid {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
}
.pcv-branch-role {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--color-text-muted);
  padding: 2px var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
}
.pcv-branch--from .pcv-branch-role {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
.pcv-branch--to .pcv-branch-role {
  color: var(--color-success);
  background: var(--color-success-soft);
}
.pcv-branch-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: var(--space-2) 0;
}
.pcv-branch-select {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-family: var(--font-mono, monospace);
  padding: var(--space-3) var(--space-4);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-branch-select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.pcv-arrow {
  color: var(--color-text-subtle);
  align-self: center;
  flex-shrink: 0;
  opacity: 0.7;
}

/* ─── Fork target selector ───────────────────────────── */
.pcv-fork-target {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.pcv-fork-opt {
  flex: 1 1 240px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  cursor: pointer;
  min-width: 0;
  transition: border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-fork-opt:hover {
  border-color: var(--color-border-strong);
}
.pcv-fork-opt--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  box-shadow: 0 0 0 1px var(--color-accent) inset;
}
.pcv-fork-opt input[type="radio"] {
  flex-shrink: 0;
  accent-color: var(--color-accent);
  margin: 0;
}
.pcv-fork-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.pcv-fork-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  padding: 2px var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
}
.pcv-fork-opt--active .pcv-fork-badge {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

/* ─── Inputs ─────────────────────────────────────────── */
.pcv-input {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-md);
  padding: var(--space-4) var(--space-5);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  font-family: inherit;
  box-sizing: border-box;
  width: 100%;
}
.pcv-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.pcv-input--title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-medium);
  padding: var(--space-5) var(--space-6);
}

.pcv-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin: 0;
  line-height: 1.5;
}
.pcv-hint--warn { color: var(--color-danger); }
.pcv-note {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-md);
  background: var(--color-warning-soft, var(--color-bg-tertiary));
  color: var(--color-warning);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
.pcv-note svg { flex-shrink: 0; }
.pcv-hint-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: baseline;
}
.pcv-counter {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.pcv-counter--over {
  color: var(--color-warning);
  font-weight: var(--font-weight-bold);
}

/* ─── Templates (segmented pill group) ──────────────── */
.pcv-templates {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.pcv-template-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-weight: var(--font-weight-medium);
}
.pcv-tpl-group {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.pcv-tpl-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  padding: 5px var(--space-4);
  border-radius: var(--radius-sm);
  cursor: pointer;
  line-height: 1.4;
  transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-tpl-btn:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

/* ─── AI generate button (matches dashboard .panel-link-ai) ─────────────── */
.btn.btn--ai.pcv-ai-btn {
  min-height: 26px;
  padding: 4px 12px;
  font-size: var(--font-size-sm);
  border-radius: var(--radius-sm);
  color: var(--color-text);
}
.btn.btn--ai.pcv-ai-btn:hover:not(:disabled) {
  color: var(--color-ai-text);
  transform: none;
  background:
    linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%) padding-box,
    linear-gradient(135deg, var(--color-accent) 0%, #c084fc 50%, var(--color-accent) 100%) border-box;
}
.pcv-spinner--sm {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}

/* ─── Editor chrome (RTE) ────────────────────────────── */
.pcv-editor {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg-secondary);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-editor:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.pcv-editor-head {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  padding: var(--space-3) var(--space-4);
  flex-wrap: wrap;
}

/* Segmented control (matches main.css .segmented) */
.pcv-tabs {
  display: inline-flex;
  padding: var(--space-1);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-md);
  gap: 0;
}
.pcv-tab {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  padding: var(--space-2) var(--space-5);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
  line-height: 1.4;
}
.pcv-tab:hover { color: var(--color-text); }
.pcv-tab--active {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  box-shadow: var(--shadow-xs, 0 1px 2px rgba(0, 0, 0, 0.06));
}

.pcv-toolbar {
  display: flex;
  gap: 2px;
  align-items: center;
  flex-wrap: wrap;
  margin-left: auto;
}
.pcv-tb-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-family: inherit;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  min-width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.pcv-tb-btn:hover { background: var(--color-bg-tertiary); color: var(--color-text); }
.pcv-tb-btn b, .pcv-tb-btn i {
  font-family: var(--font-mono, monospace);
  font-style: normal;
  font-weight: 700;
}
.pcv-tb-btn i { font-style: italic; }
.pcv-tb-sep {
  width: 1px;
  height: 18px;
  background: var(--color-border);
  margin: 0 var(--space-2);
}

.pcv-textarea {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  resize: vertical;
  min-height: 260px;
  padding: var(--space-5) var(--space-6);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-md);
  line-height: 1.65;
  box-sizing: border-box;
}
.pcv-textarea::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
}

.pcv-preview {
  min-height: 260px;
  padding: var(--space-5) var(--space-6);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-md);
  line-height: 1.65;
}
.pcv-preview :deep(h1),
.pcv-preview :deep(h2),
.pcv-preview :deep(h3),
.pcv-preview :deep(h4) {
  margin: 12px 0 6px 0;
  font-weight: var(--font-weight-bold);
  color: var(--color-text);
}
.pcv-preview :deep(h1) { font-size: 18px; border-bottom: 1px solid var(--color-border); padding-bottom: 4px; }
.pcv-preview :deep(h2) { font-size: 16px; }
.pcv-preview :deep(h3) { font-size: 14px; }
.pcv-preview :deep(p)  { margin: 6px 0; }
.pcv-preview :deep(ul), .pcv-preview :deep(ol) { margin: 6px 0; padding-left: 22px; }
.pcv-preview :deep(li) { margin: 2px 0; }
.pcv-preview :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--color-border);
  color: var(--color-text-muted);
}
.pcv-preview :deep(a) { color: var(--color-accent); text-decoration: underline; }
.pcv-preview :deep(.md-inline-code) {
  font-family: var(--font-mono, monospace);
  font-size: 0.9em;
  padding: 1px 5px;
  background: var(--color-bg-tertiary);
  border-radius: 4px;
}
.pcv-preview :deep(.md-code-block) {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  overflow-x: auto;
  font-size: var(--font-size-sm);
  margin: 8px 0;
}
.pcv-preview :deep(.md-code-block code) {
  font-family: var(--font-mono, monospace);
}
.pcv-preview :deep(.pcv-preview-empty) {
  color: var(--color-text-muted);
  font-style: italic;
}
.pcv-preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 12px 0;
}

/* ─── Reviewers ──────────────────────────────────────── */
.pcv-reviewers {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: text;
  min-height: 44px;
  box-sizing: border-box;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-reviewers:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.pcv-reviewer-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-4);
  line-height: 1.4;
  font-family: var(--font-mono, monospace);
}
.pcv-reviewer-at { opacity: 0.7; }
.pcv-reviewer-remove {
  background: transparent;
  border: none;
  color: inherit;
  padding: 2px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}
.pcv-reviewer-remove:hover {
  opacity: 1;
  background: var(--color-accent);
  color: var(--color-accent-text);
}
.pcv-reviewer-input {
  flex: 1;
  min-width: 160px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-family: inherit;
  padding: var(--space-2) var(--space-3);
}

/* Suggestion dropdown */
.pcv-reviewer-suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.18));
  max-height: 240px;
  overflow-y: auto;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pcv-suggest-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-family: inherit;
  transition: background var(--transition-fast);
}
.pcv-suggest-item:hover,
.pcv-suggest-item--active {
  background: var(--color-accent-soft);
}
.pcv-suggest-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-bg-tertiary);
  flex-shrink: 0;
  object-fit: cover;
}
.pcv-suggest-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  flex: 1;
}
.pcv-suggest-login {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pcv-suggest-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pcv-suggest-empty {
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-style: italic;
}

/* ─── Options (draft card) ──────────────────────────── */
.pcv-check {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  background: var(--color-bg);
  transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.pcv-check:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-strong);
}
.pcv-check--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  box-shadow: 0 0 0 1px var(--color-accent) inset;
}
.pcv-check input[type="checkbox"] {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  accent-color: var(--color-accent);
  margin: 0;
}
.pcv-check-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.pcv-check--active .pcv-check-icon {
  background: var(--color-accent);
  color: var(--color-accent-text);
}
.pcv-check-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pcv-check-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}
.pcv-check-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
}

/* ─── Messages ───────────────────────────────────────── */
.pcv-msg {
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  border: 1px solid transparent;
}
.pcv-msg--error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-color: var(--color-danger);
}

/* ─── Footer ─────────────────────────────────────────── */
.pcv-footer {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
  padding: var(--space-5) 0;
  border-top: 1px solid var(--color-border);
  margin-top: auto;
  padding-bottom: var(--space-12);
}
.pcv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-6);
  min-height: 36px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  font-family: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
}
.pcv-btn--ghost {
  background: var(--color-bg);
  color: var(--color-text-muted);
  border-color: var(--color-border);
}
.pcv-btn--ghost:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-strong);
}
.pcv-btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 0 var(--color-accent-soft);
  width: 100%;
}
.pcv-btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22), 0 0 0 3px var(--color-accent-soft);
}
.pcv-btn--primary:active:not(:disabled) {
  transform: translateY(0);
}
.pcv-btn:disabled { opacity: 0.5; cursor: not-allowed; }

@media (prefers-reduced-motion: reduce) {
  .pcv-btn,
  .pcv-btn--primary:hover,
  .pcv-btn--primary:active {
    transition: none;
    transform: none;
  }
  .pcv-spinner {
    animation: none;
  }
}

.pcv-spinner {
  width: 12px; height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: pcv-spin 0.7s linear infinite;
}
@keyframes pcv-spin { to { transform: rotate(360deg); } }

/* ─── Template confirmation modal ────────────────────── */
.pcv-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--color-overlay, rgba(0, 0, 0, 0.55));
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: pcv-fade 0.15s ease-out;
}
.pcv-modal {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl, 12px);
  padding: var(--space-8);
  width: 420px;
  max-width: 90vw;
  text-align: center;
  box-shadow: var(--shadow-xl, 0 20px 60px rgba(0,0,0,0.4));
  animation: pcv-pop 0.18s ease-out;
}
.pcv-modal-icon { margin-bottom: var(--space-4); color: var(--color-warning); }
.pcv-modal-title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}
.pcv-modal-desc {
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  margin: 0 0 var(--space-6);
  line-height: 1.5;
}
.pcv-modal-actions {
  display: flex;
  justify-content: center;
  gap: var(--space-3);
}

@keyframes pcv-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes pcv-pop  { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
</style>

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
import { computed, inject, nextTick, ref, useTemplateRef, watch } from "vue";
import { PR_PANEL_KEY, type PrPanelState } from "../composables/usePrPanel";
import type { GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{
  currentBranch: string;
  branches: GitBranch[];
}>();

const emit = defineEmits<{ (e: "cancel"): void }>();

const p = inject<PrPanelState>(PR_PANEL_KEY)!;
const { t } = useI18n();

// ─── Base branch candidates ─────────────────────────────
const baseCandidates = computed<string[]>(() => {
  const locals = new Set<string>();
  const remoteOnly: string[] = [];
  for (const b of props.branches) {
    if (!b.isRemote && b.name !== props.currentBranch) locals.add(b.name);
  }
  for (const b of props.branches) {
    if (b.isRemote) {
      const bare = b.name.replace(/^[^/]+\//, "");
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
const templates: Template[] = [
  { key: "feat",  label: "Feature",         body: "## Contexte\n\n_Pourquoi ce changement ?_\n\n## Changements\n\n- \n\n## Comment tester\n\n1. " },
  { key: "fix",   label: "Bugfix",          body: "## Problème\n\n_Décris le bug._\n\n## Cause\n\n## Correctif\n\n## Comment reproduire / tester\n\n1. " },
  { key: "chore", label: "Chore / Refacto", body: "## Contexte\n\n## Changements\n\n- \n\n## Impact\n\n_Rien de fonctionnel, uniquement interne._" },
  { key: "docs",  label: "Docs",            body: "## Contexte\n\n## Changements\n\n- " },
];

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

// ─── Minimal Markdown → HTML renderer ───────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(src: string): string {
  if (!src.trim()) return `<p class="pcv-preview-empty">${t("pr.create.previewEmpty")}</p>`;
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = fence[1];
        codeBuf = [];
      } else {
        inCode = false;
        out.push(`<pre class="pcv-code"><code${codeLang ? ` class="lang-${escapeHtml(codeLang)}"` : ""}>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
      }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++; continue;
    }
    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^-{3,}\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      i++; continue;
    }

    // Blank line → close list / paragraph break
    if (line.trim() === "") { closeList(); i++; continue; }

    // Paragraph — consume contiguous non-empty lines
    closeList();
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^#{1,6}\s/.test(lines[i]) && !/^```/.test(lines[i]) &&
           !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^>\s?/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre class="pcv-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

function inline(text: string): string {
  let s = escapeHtml(text);
  // Inline code first (protect from other transforms)
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code class="pcv-inline-code">${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
  // Bold **x** / __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // Italic *x* / _x_
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
  // Restore inline code
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
  return s;
}

const bodyPreview = computed(() => renderMarkdown(p.newPrBody.value));

// ─── Validation ─────────────────────────────────────────
const canSubmit = computed(
  () =>
    p.newPrTitle.value.trim().length > 0 &&
    p.newPrBase.value.trim().length > 0 &&
    p.newPrBase.value.trim() !== props.currentBranch &&
    !p.isCreating.value,
);
const baseIsSameAsHead = computed(() => p.newPrBase.value.trim() === props.currentBranch);

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
// Simple tag-style input: user types a username (or org/team-slug), press
// Enter, space or comma to add. Backspace on empty input removes the last.
const reviewerInput = ref("");

function addReviewer(raw: string) {
  const name = raw.trim().replace(/^@/, "").replace(/,+$/, "");
  if (!name) return;
  if (p.newPrReviewers.value.includes(name)) return;
  p.newPrReviewers.value = [...p.newPrReviewers.value, name];
}

function onReviewerKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === "," || e.key === " ") {
    if (reviewerInput.value.trim()) {
      e.preventDefault();
      addReviewer(reviewerInput.value);
      reviewerInput.value = "";
    } else if (e.key === "Enter") {
      // let Ctrl+Enter global handler still submit
    }
  } else if (e.key === "Backspace" && reviewerInput.value === "" && p.newPrReviewers.value.length > 0) {
    p.newPrReviewers.value = p.newPrReviewers.value.slice(0, -1);
  }
}

function onReviewerBlur() {
  if (reviewerInput.value.trim()) {
    addReviewer(reviewerInput.value);
    reviewerInput.value = "";
  }
}

function removeReviewer(name: string) {
  p.newPrReviewers.value = p.newPrReviewers.value.filter((r) => r !== name);
}
</script>

<template>
  <div class="pcv-root" @keydown="onKeydown">
    <div class="pcv-container">

      <!-- Header (no close button; footer has Annuler) -->
      <header class="pcv-header">
        <h1 class="pcv-title">{{ t("pr.create.title") }}</h1>
        <p class="pcv-subtitle">{{ t("pr.create.subtitle") }}</p>
      </header>

      <!-- Messages -->
      <div v-if="p.error.value" class="pcv-msg pcv-msg--error">{{ p.error.value }}</div>

      <!-- Branch flow -->
      <section class="pcv-section">
        <label class="pcv-label">{{ t("pr.create.branchesLabel") }}</label>
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
        <label class="pcv-label" for="pcv-title-input">{{ t("pr.create.titleLabel") }}</label>
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
      </section>

      <!-- Description RTE -->
      <section class="pcv-section">
        <div class="pcv-label-row">
          <label class="pcv-label" for="pcv-body-input">{{ t("pr.create.bodyLabel") }}</label>
          <div class="pcv-templates">
            <span class="pcv-template-label">{{ t("pr.create.templateLabel") }}</span>
            <button
              v-for="tpl in templates"
              :key="tpl.key"
              type="button"
              class="pcv-tpl-btn"
              @click="applyTemplate(tpl)"
            >{{ tpl.label }}</button>
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
            v-html="bodyPreview"
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
            @blur="onReviewerBlur"
          />
        </div>
        <p class="pcv-hint">{{ t("pr.create.reviewersHint") }}</p>
      </section>

      <!-- Options -->
      <section class="pcv-section">
        <label class="pcv-check">
          <input type="checkbox" v-model="p.newPrDraft.value" />
          <div class="pcv-check-text">
            <span class="pcv-check-title">{{ t("pr.create.draftLabel") }}</span>
            <span class="pcv-check-hint">{{ t("pr.create.draftHint") }}</span>
          </div>
        </label>
      </section>

      <!-- Footer -->
      <footer class="pcv-footer">
        <button class="pcv-btn pcv-btn--ghost" @click="onCancel" :disabled="p.isCreating.value">
          {{ t("common.cancel") }}
        </button>
        <button
          class="pcv-btn pcv-btn--primary"
          :disabled="!canSubmit"
          @click="onSubmit"
          :title="t('common.ctrlEnter')"
        >
          <span v-if="p.isCreating.value" class="pcv-spinner" aria-hidden="true"></span>
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
/* ─── Root: full-bleed, theme bg ─────────────────────── */
.pcv-root {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--color-bg);
  overflow-y: auto;
  box-sizing: border-box;
}

.pcv-container {
  max-width: 920px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-8) var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-height: 100%;
  box-sizing: border-box;
}

/* ─── Header ─────────────────────────────────────────── */
.pcv-header {
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}
.pcv-title {
  font-size: var(--font-size-xl, 18px);
  font-weight: var(--font-weight-bold);
  margin: 0 0 4px 0;
  color: var(--color-text);
}
.pcv-subtitle {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: 1.4;
}

/* ─── Sections ───────────────────────────────────────── */
.pcv-section { display: flex; flex-direction: column; gap: var(--space-2); }
.pcv-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-bold);
  color: var(--color-text);
  letter-spacing: 0.02em;
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
  gap: var(--space-2);
  flex-wrap: wrap;
}
.pcv-branch {
  flex: 1 1 260px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 6px);
  background: var(--color-bg-secondary);
  min-width: 0;
}
.pcv-branch--from { border-left: 3px solid var(--color-accent); }
.pcv-branch--to   { border-left: 3px solid var(--color-success); }
.pcv-branch--invalid { border-color: var(--color-danger); background: var(--color-danger-soft); }
.pcv-branch-role {
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}
.pcv-branch-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pcv-branch-select {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-family: var(--font-mono, monospace);
  padding: 4px 8px;
  outline: none;
  transition: border-color var(--transition-fast);
}
.pcv-branch-select:focus { border-color: var(--color-accent); }
.pcv-arrow { color: var(--color-text-muted); align-self: center; flex-shrink: 0; }

/* ─── Inputs ─────────────────────────────────────────── */
.pcv-input {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-md);
  padding: 8px 10px;
  outline: none;
  transition: border-color var(--transition-fast);
  font-family: inherit;
  box-sizing: border-box;
  width: 100%;
}
.pcv-input:focus { border-color: var(--color-accent); }
.pcv-input--title {
  font-size: var(--font-size-lg, 14px);
  font-weight: var(--font-weight-medium);
}

.pcv-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin: 0;
  line-height: 1.4;
}
.pcv-hint--warn { color: var(--color-danger); }
.pcv-hint-row { display: flex; justify-content: space-between; gap: var(--space-2); }
.pcv-counter { font-size: var(--font-size-sm); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.pcv-counter--over { color: var(--color-warning); font-weight: var(--font-weight-bold); }

/* ─── Templates ──────────────────────────────────────── */
.pcv-templates { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pcv-template-label { font-size: var(--font-size-sm); color: var(--color-text-muted); }
.pcv-tpl-btn {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  padding: 2px 10px;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.pcv-tpl-btn:hover {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

/* ─── Editor chrome (RTE) ────────────────────────────── */
.pcv-editor {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
  background: var(--color-bg);
}
.pcv-editor-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  padding: 4px 6px;
  flex-wrap: wrap;
}
.pcv-tabs { display: flex; gap: 2px; }
.pcv-tab {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.pcv-tab:hover { background: var(--color-bg-tertiary); color: var(--color-text); }
.pcv-tab--active {
  background: var(--color-bg);
  color: var(--color-text);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}

.pcv-toolbar { display: flex; gap: 1px; align-items: center; flex-wrap: wrap; margin-left: auto; }
.pcv-tb-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-family: inherit;
  padding: 4px 7px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  min-width: 26px;
  line-height: 1;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.pcv-tb-btn:hover { background: var(--color-bg-tertiary); color: var(--color-text); }
.pcv-tb-btn b, .pcv-tb-btn i { font-family: var(--font-mono, monospace); font-style: normal; font-weight: 700; }
.pcv-tb-btn i { font-style: italic; }
.pcv-tb-sep {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  margin: 0 4px;
}

.pcv-textarea {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  resize: vertical;
  min-height: 220px;
  padding: var(--space-3);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  box-sizing: border-box;
}

.pcv-preview {
  min-height: 220px;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-size-md);
  line-height: 1.6;
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
.pcv-preview :deep(.pcv-inline-code) {
  font-family: var(--font-mono, monospace);
  font-size: 0.9em;
  padding: 1px 5px;
  background: var(--color-bg-tertiary);
  border-radius: 4px;
}
.pcv-preview :deep(.pcv-code) {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  overflow-x: auto;
  font-size: var(--font-size-sm);
  margin: 8px 0;
}
.pcv-preview :deep(.pcv-code code) {
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
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding: 6px 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: text;
  min-height: 36px;
  box-sizing: border-box;
}
.pcv-reviewers:focus-within { border-color: var(--color-accent); }
.pcv-reviewer-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-sm);
  padding: 1px 4px 1px 8px;
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
  min-width: 120px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-family: inherit;
  padding: 2px 4px;
}

/* ─── Options ────────────────────────────────────────── */
.pcv-check {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.pcv-check:hover { background: var(--color-bg-secondary); }
.pcv-check input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; }
.pcv-check-text { display: flex; flex-direction: column; gap: 2px; }
.pcv-check-title { font-size: var(--font-size-md); font-weight: var(--font-weight-medium); color: var(--color-text); }
.pcv-check-hint { font-size: var(--font-size-sm); color: var(--color-text-muted); line-height: 1.4; }

/* ─── Messages ───────────────────────────────────────── */
.pcv-msg {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
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
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
  position: sticky;
  bottom: 0;
  background: var(--color-bg);
  margin-top: auto;
}
.pcv-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}
.pcv-btn--ghost {
  background: transparent;
  color: var(--color-text-muted);
  border-color: var(--color-border);
}
.pcv-btn--ghost:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}
.pcv-btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
}
.pcv-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
.pcv-btn:disabled { opacity: 0.5; cursor: not-allowed; }

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
  font-size: var(--font-size-lg, 16px);
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

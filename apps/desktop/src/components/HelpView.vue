<script setup lang="ts">
/**
 * HelpView — full-screen in-app help panel.
 *
 * Triggered by:
 *  - The ? button in AppHeader (right cluster)
 *  - macOS menu bar: Help → Documentation
 *  - Escape key (handled by App.vue's global Escape handler)
 *
 * Structure: fixed overlay that sits above everything (z-index: 60),
 * matching the SettingsPanel layer. Left nav switches between six
 * sections; right pane scrolls the content.
 */
import { ref } from "vue";
import { useI18n } from "../composables/useI18n";
import type { LocaleKey } from "../locales";

const { t } = useI18n();

const emit = defineEmits<{
  close: [];
}>();

type SectionId =
  | "gettingStarted"
  | "conflictResolution"
  | "keyboardShortcuts"
  | "gitWorkflow"
  | "aiFeatures"
  | "faq";

const activeSection = ref<SectionId>("gettingStarted");

const sections: { id: SectionId; navKey: LocaleKey }[] = [
  { id: "gettingStarted",    navKey: "help.nav.gettingStarted" },
  { id: "conflictResolution", navKey: "help.nav.conflictResolution" },
  { id: "keyboardShortcuts", navKey: "help.nav.keyboardShortcuts" },
  { id: "gitWorkflow",       navKey: "help.nav.gitWorkflow" },
  { id: "aiFeatures",        navKey: "help.nav.aiFeatures" },
  { id: "faq",               navKey: "help.nav.faq" },
];

const shortcuts: { action: LocaleKey; keys: string[] }[] = [
  { action: "help.keyboardShortcuts.openRepo",    keys: ["⌘O"] },
  { action: "help.keyboardShortcuts.settings",    keys: ["⌘,"] },
  { action: "help.keyboardShortcuts.commandPalette", keys: ["⌘K"] },
  { action: "help.keyboardShortcuts.fetch",       keys: ["⌘⇧F"] },
  { action: "help.keyboardShortcuts.push",        keys: ["⌘P"] },
  { action: "help.keyboardShortcuts.newBranch",   keys: ["⌘⇧B"] },
  { action: "help.keyboardShortcuts.terminal",    keys: ["⌘⇧T"] },
  { action: "help.keyboardShortcuts.toggleSidebar", keys: ["⌘⇧S"] },
  { action: "help.keyboardShortcuts.undoMerge",   keys: ["⌘Z"] },
  { action: "help.keyboardShortcuts.redoMerge",   keys: ["⌘⇧Z"] },
  { action: "help.keyboardShortcuts.saveAll",     keys: ["⌘S"] },
  { action: "help.keyboardShortcuts.closeOverlay", keys: ["Esc"] },
  // PR Review — Diff tab only (B1, v3.6.0)
  { action: "help.keyboardShortcuts.prNextHunk",   keys: ["J"] },
  { action: "help.keyboardShortcuts.prPrevHunk",   keys: ["K"] },
  { action: "help.keyboardShortcuts.prNextFile",   keys: ["⇧J"] },
  { action: "help.keyboardShortcuts.prPrevFile",   keys: ["⇧K"] },
  { action: "help.keyboardShortcuts.prToggleViewed", keys: ["V"] },
  { action: "help.keyboardShortcuts.prHideViewed", keys: ["⇧V"] },
  { action: "help.keyboardShortcuts.prFilterFiles", keys: ["T"] },
  { action: "help.keyboardShortcuts.prCommentHunk", keys: ["C"] },
  { action: "help.keyboardShortcuts.prNextFinding", keys: ["N"] },
  { action: "help.keyboardShortcuts.prPrevFinding", keys: ["P"] },
  { action: "help.keyboardShortcuts.prSubmitReview", keys: ["⌘↵"] },
];
</script>

<template>
  <div class="help-view" role="dialog" :aria-label="t('help.title')">
    <!-- Header -->
    <div class="help-header">
      <div class="help-header__left">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.4" />
          <path d="M10 13.5v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M10 6.5c1.1 0 2 .9 2 2s-.9 1.5-2 1.5V11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="help-header__title">{{ t('help.title') }}</span>
      </div>
      <button
        class="help-close"
        :aria-label="t('help.close')"
        :title="t('help.close')"
        @click="emit('close')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="help-body">
      <!-- Left navigation -->
      <nav class="help-nav" aria-label="Help sections">
        <button
          v-for="section in sections"
          :key="section.id"
          class="help-nav__item"
          :class="{ 'help-nav__item--active': activeSection === section.id }"
          @click="activeSection = section.id"
        >
          {{ t(section.navKey) }}
        </button>
      </nav>

      <!-- Content area -->
      <div class="help-content">

        <!-- Getting started -->
        <section v-if="activeSection === 'gettingStarted'" class="help-section">
          <h2 class="help-section__title">{{ t('help.gettingStarted.title') }}</h2>
          <p class="help-section__intro">{{ t('help.gettingStarted.intro') }}</p>

          <div class="help-steps">
            <div class="help-step">
              <div class="help-step__number">1</div>
              <div class="help-step__body">
                <h3 class="help-step__title">{{ t('help.gettingStarted.step1Title') }}</h3>
                <p>{{ t('help.gettingStarted.step1') }}</p>
              </div>
            </div>
            <div class="help-step">
              <div class="help-step__number">2</div>
              <div class="help-step__body">
                <h3 class="help-step__title">{{ t('help.gettingStarted.step2Title') }}</h3>
                <p>{{ t('help.gettingStarted.step2') }}</p>
              </div>
            </div>
            <div class="help-step">
              <div class="help-step__number">3</div>
              <div class="help-step__body">
                <h3 class="help-step__title">{{ t('help.gettingStarted.step3Title') }}</h3>
                <p>{{ t('help.gettingStarted.step3') }}</p>
              </div>
            </div>
          </div>
        </section>

        <!-- Conflict resolution -->
        <section v-else-if="activeSection === 'conflictResolution'" class="help-section">
          <h2 class="help-section__title">{{ t('help.conflictResolution.title') }}</h2>
          <p class="help-section__intro">{{ t('help.conflictResolution.intro') }}</p>

          <div class="help-steps">
            <div class="help-step">
              <div class="help-step__number">1</div>
              <div class="help-step__body">
                <h3 class="help-step__title">{{ t('help.conflictResolution.step1Title') }}</h3>
                <p>{{ t('help.conflictResolution.step1') }}</p>
              </div>
            </div>
            <div class="help-step">
              <div class="help-step__number">2</div>
              <div class="help-step__body">
                <h3 class="help-step__title">{{ t('help.conflictResolution.step2Title') }}</h3>
                <p>{{ t('help.conflictResolution.step2') }}</p>
              </div>
            </div>
            <div class="help-step">
              <div class="help-step__number">3</div>
              <div class="help-step__body">
                <h3 class="help-step__title">{{ t('help.conflictResolution.step3Title') }}</h3>
                <p>{{ t('help.conflictResolution.step3') }}</p>
              </div>
            </div>
          </div>
        </section>

        <!-- Keyboard shortcuts -->
        <section v-else-if="activeSection === 'keyboardShortcuts'" class="help-section">
          <h2 class="help-section__title">{{ t('help.keyboardShortcuts.title') }}</h2>
          <p class="help-section__intro">{{ t('help.keyboardShortcuts.intro') }}</p>

          <table class="help-shortcuts">
            <thead>
              <tr>
                <th>{{ t('help.keyboardShortcuts.colAction') }}</th>
                <th>{{ t('help.keyboardShortcuts.colShortcut') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="shortcut in shortcuts" :key="shortcut.action">
                <td>{{ t(shortcut.action) }}</td>
                <td class="help-shortcuts__keys">
                  <kbd v-for="key in shortcut.keys" :key="key">{{ key }}</kbd>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- Git workflow -->
        <section v-else-if="activeSection === 'gitWorkflow'" class="help-section">
          <h2 class="help-section__title">{{ t('help.gitWorkflow.title') }}</h2>
          <p class="help-section__intro">{{ t('help.gitWorkflow.intro') }}</p>

          <div class="help-cards">
            <div class="help-card">
              <h3 class="help-card__title">{{ t('help.gitWorkflow.branchTitle') }}</h3>
              <p>{{ t('help.gitWorkflow.branch') }}</p>
            </div>
            <div class="help-card">
              <h3 class="help-card__title">{{ t('help.gitWorkflow.stageTitle') }}</h3>
              <p>{{ t('help.gitWorkflow.stage') }}</p>
            </div>
            <div class="help-card">
              <h3 class="help-card__title">{{ t('help.gitWorkflow.historyTitle') }}</h3>
              <p>{{ t('help.gitWorkflow.history') }}</p>
            </div>
            <div class="help-card">
              <h3 class="help-card__title">{{ t('help.gitWorkflow.remoteTitle') }}</h3>
              <p>{{ t('help.gitWorkflow.remote') }}</p>
            </div>
          </div>
        </section>

        <!-- AI features -->
        <section v-else-if="activeSection === 'aiFeatures'" class="help-section">
          <h2 class="help-section__title">{{ t('help.aiFeatures.title') }}</h2>
          <p class="help-section__intro">{{ t('help.aiFeatures.intro') }}</p>

          <div class="help-cards">
            <div class="help-card">
              <h3 class="help-card__title">
                <span class="help-card__icon" aria-hidden="true">✦</span>
                {{ t('help.aiFeatures.commitTitle') }}
              </h3>
              <p>{{ t('help.aiFeatures.commit') }}</p>
            </div>
            <div class="help-card">
              <h3 class="help-card__title">
                <span class="help-card__icon" aria-hidden="true">✦</span>
                {{ t('help.aiFeatures.mergeTitle') }}
              </h3>
              <p>{{ t('help.aiFeatures.merge') }}</p>
            </div>
            <div class="help-card">
              <h3 class="help-card__title">{{ t('help.aiFeatures.settingsTitle') }}</h3>
              <p>{{ t('help.aiFeatures.settings') }}</p>
            </div>
          </div>
        </section>

        <!-- FAQ -->
        <section v-else-if="activeSection === 'faq'" class="help-section">
          <h2 class="help-section__title">{{ t('help.faq.title') }}</h2>

          <div class="help-faq">
            <details class="help-faq__item">
              <summary class="help-faq__question">{{ t('help.faq.q1') }}</summary>
              <p class="help-faq__answer">{{ t('help.faq.a1') }}</p>
            </details>
            <details class="help-faq__item">
              <summary class="help-faq__question">{{ t('help.faq.q2') }}</summary>
              <p class="help-faq__answer">{{ t('help.faq.a2') }}</p>
            </details>
            <details class="help-faq__item">
              <summary class="help-faq__question">{{ t('help.faq.q3') }}</summary>
              <p class="help-faq__answer">{{ t('help.faq.a3') }}</p>
            </details>
            <details class="help-faq__item">
              <summary class="help-faq__question">{{ t('help.faq.q4') }}</summary>
              <p class="help-faq__answer">{{ t('help.faq.a4') }}</p>
            </details>
            <details class="help-faq__item">
              <summary class="help-faq__question">{{ t('help.faq.q5') }}</summary>
              <p class="help-faq__answer">{{ t('help.faq.a5') }}</p>
            </details>
          </div>
        </section>

      </div>
    </div>
  </div>
</template>

<style scoped>
/* ─── Overlay shell ──────────────────────────────────────── */
.help-view {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  color: var(--color-text);
  animation: helpFadeIn var(--transition-slow, 150ms) ease;
}

@keyframes helpFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ─── Header ─────────────────────────────────────────────── */
.help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height, 48px);
  padding: 0 var(--space-6, 20px);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.help-header__left {
  display: flex;
  align-items: center;
  gap: var(--space-3, 8px);
  color: var(--color-text-muted);
}

.help-header__title {
  font-size: var(--font-size-md, 14px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--color-text);
}

.help-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill, 9999px);
  background: transparent;
  color: var(--color-text-muted);
  transition: background var(--transition-base), color var(--transition-base);
  cursor: pointer;
}
.help-close:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

/* ─── Body layout ────────────────────────────────────────── */
.help-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ─── Left nav ───────────────────────────────────────────── */
.help-nav {
  width: 200px;
  flex-shrink: 0;
  padding: var(--space-5, 16px) var(--space-4, 12px);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 2px);
  overflow-y: auto;
}

.help-nav__item {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--space-3, 6px) var(--space-4, 12px);
  border-radius: var(--radius-md, 6px);
  font-size: var(--font-size-base, 13px);
  color: var(--color-text-muted);
  background: transparent;
  transition: background var(--transition-base), color var(--transition-base);
  cursor: pointer;
  white-space: nowrap;
}
.help-nav__item:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
.help-nav__item--active {
  background: var(--color-accent-soft, rgba(99, 102, 241, 0.1));
  color: var(--color-accent);
  font-weight: var(--font-weight-medium, 500);
}

/* ─── Content pane ───────────────────────────────────────── */
.help-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-8, 32px) var(--space-10, 48px);
  max-width: 760px;
}

.help-section {}

.help-section__title {
  font-size: var(--font-size-xl, 20px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--color-text);
  margin-bottom: var(--space-4, 12px);
}

.help-section__intro {
  font-size: var(--font-size-base, 13px);
  color: var(--color-text-muted);
  line-height: 1.6;
  margin-bottom: var(--space-7, 24px);
}

/* ─── Steps ──────────────────────────────────────────────── */
.help-steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-5, 16px);
}

.help-step {
  display: flex;
  gap: var(--space-5, 16px);
  align-items: flex-start;
}

.help-step__number {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill, 9999px);
  background: var(--color-accent-soft, rgba(99, 102, 241, 0.12));
  color: var(--color-accent);
  font-size: var(--font-size-sm, 12px);
  font-weight: var(--font-weight-semibold, 600);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}

.help-step__body {
  flex: 1;
  min-width: 0;
}

.help-step__title {
  font-size: var(--font-size-md, 14px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--color-text);
  margin-bottom: var(--space-2, 4px);
}

.help-step__body p {
  font-size: var(--font-size-base, 13px);
  color: var(--color-text-muted);
  line-height: 1.6;
}

/* ─── Cards ──────────────────────────────────────────────── */
.help-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-5, 16px);
}

.help-card {
  padding: var(--space-5, 16px) var(--space-6, 20px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 10px);
}

.help-card__title {
  font-size: var(--font-size-md, 14px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--color-text);
  margin-bottom: var(--space-3, 6px);
  display: flex;
  align-items: center;
  gap: var(--space-2, 4px);
}

.help-card__icon {
  color: var(--color-accent);
  font-style: normal;
  font-size: 12px;
}

.help-card p {
  font-size: var(--font-size-base, 13px);
  color: var(--color-text-muted);
  line-height: 1.6;
}

/* ─── Shortcuts table ────────────────────────────────────── */
.help-shortcuts {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-base, 13px);
}

.help-shortcuts th {
  text-align: left;
  padding: var(--space-3, 6px) var(--space-4, 12px);
  font-size: var(--font-size-xs, 11px);
  font-weight: var(--font-weight-semibold, 600);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}

.help-shortcuts td {
  padding: var(--space-3, 8px) var(--space-4, 12px);
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
}

.help-shortcuts tr:last-child td {
  border-bottom: none;
}

.help-shortcuts__keys {
  display: flex;
  gap: var(--space-2, 4px);
}

kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 22px;
  padding: 0 var(--space-2, 4px);
  font-size: var(--font-size-xs, 11px);
  font-family: var(--font-mono, monospace);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 4px);
  box-shadow: 0 1px 0 var(--color-border);
}

/* ─── FAQ accordion ──────────────────────────────────────── */
.help-faq {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.help-faq__item {
  border-bottom: 1px solid var(--color-border);
}
.help-faq__item:first-child {
  border-top: 1px solid var(--color-border);
}

.help-faq__question {
  display: flex;
  align-items: center;
  padding: var(--space-5, 16px) var(--space-2, 4px);
  font-size: var(--font-size-md, 14px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--color-text);
  cursor: pointer;
  list-style: none;
  gap: var(--space-3, 8px);
  transition: color var(--transition-base);
}
.help-faq__question:hover {
  color: var(--color-accent);
}
.help-faq__question::before {
  content: "+";
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 300;
  color: var(--color-text-muted);
  transition: transform var(--transition-base);
}
details[open] .help-faq__question::before {
  transform: rotate(45deg);
}

.help-faq__answer {
  padding: 0 var(--space-7, 28px) var(--space-5, 16px);
  font-size: var(--font-size-base, 13px);
  color: var(--color-text-muted);
  line-height: 1.6;
}
</style>

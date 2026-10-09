<script setup lang="ts">
import { ref, computed, reactive } from "vue";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import { useCustomAutomations, type CustomAutomationRule } from "../composables/useCustomAutomations";

const { t } = useI18n();
const { settings, saveSettings } = useSettings();

// ─── Helpers ─────────────────────────────────────────────

const lastRunMap = computed<Record<string, string>>(() => {
  try {
    return JSON.parse(localStorage.getItem("gitwand-scheduler-last-run") ?? "{}");
  } catch {
    return {};
  }
});

function lastRunLabel(key: string): string {
  const iso = lastRunMap.value[key];
  if (!iso) return t("automations.neverRun");
  const d = new Date(iso);
  return t("automations.lastRun").replace(
    "{0}",
    d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  );
}

function formatNightlyTime(): string {
  const { hour, minute } = settings.value.automations.nightlyPull;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// ─── Toggle helpers ───────────────────────────────────────

function toggleAutoResolve(e: Event) {
  settings.value.automations.autoResolve.enabled = (e.target as HTMLInputElement).checked;
  saveSettings(settings.value);
}

function toggleNightlyPull(e: Event) {
  settings.value.automations.nightlyPull.enabled = (e.target as HTMLInputElement).checked;
  saveSettings(settings.value);
}

function setNightlyHour(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value);
  if (!isNaN(v)) {
    settings.value.automations.nightlyPull.hour = Math.max(0, Math.min(23, v));
    saveSettings(settings.value);
  }
}

function setNightlyMinute(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value);
  if (!isNaN(v)) {
    settings.value.automations.nightlyPull.minute = Math.max(0, Math.min(59, v));
    saveSettings(settings.value);
  }
}

function toggleReleaseNotes(e: Event) {
  settings.value.automations.releaseNotes.enabled = (e.target as HTMLInputElement).checked;
  saveSettings(settings.value);
}

function toggleAiCommitBatch(e: Event) {
  settings.value.automations.aiCommitBatch.enabled = (e.target as HTMLInputElement).checked;
  saveSettings(settings.value);
}

// ─── Manual run tracking ──────────────────────────────────
const runningTask = ref<string | null>(null);

// ─── Custom automation rules ──────────────────────────────
const { rules, addRule, updateRule, deleteRule, toggleRule } = useCustomAutomations();

const showAddForm = ref(false);
const editingId = ref<string | null>(null);

const blankForm = (): Omit<CustomAutomationRule, "id"> => ({
  name: "",
  trigger: "",
  command: "",
  commitMessage: "",
  enabled: true,
});

const form = reactive<Omit<CustomAutomationRule, "id">>(blankForm());

function openAddForm() {
  Object.assign(form, blankForm());
  editingId.value = null;
  showAddForm.value = true;
}

function openEditForm(rule: CustomAutomationRule) {
  Object.assign(form, {
    name: rule.name,
    trigger: rule.trigger,
    command: rule.command,
    commitMessage: rule.commitMessage,
    enabled: rule.enabled,
  });
  editingId.value = rule.id;
  showAddForm.value = true;
}

function cancelForm() {
  showAddForm.value = false;
  editingId.value = null;
}

function submitForm() {
  if (!form.name.trim() || !form.trigger.trim() || !form.command.trim()) return;
  if (editingId.value) {
    updateRule(editingId.value, { ...form });
  } else {
    addRule({ ...form });
  }
  cancelForm();
}
</script>

<template>
  <div class="aup-panel">

    <!-- ── Auto-resolve ─────────────────────────────────── -->
    <div class="aup-card">
      <div class="aup-card-head">
        <div class="aup-card-info">
          <div class="aup-card-title">
            <!-- lightning bolt icon -->
            <svg class="aup-task-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            {{ t("automations.taskAutoResolve") }}
          </div>
          <p class="aup-card-desc">{{ t("automations.taskAutoResolveDesc") }}</p>
          <span class="aup-trigger">{{ t("automations.taskAutoResolveTrigger") }}</span>
        </div>
        <label class="aup-toggle">
          <input
            type="checkbox"
            :checked="settings.automations.autoResolve.enabled"
            @change="toggleAutoResolve"
          />
          <span class="aup-toggle-track"><span class="aup-toggle-thumb" /></span>
        </label>
      </div>
      <div class="aup-card-foot">
        <span class="aup-last-run">{{ lastRunLabel("autoResolve") }}</span>
      </div>
    </div>

    <!-- ── Nightly pull ──────────────────────────────────── -->
    <div class="aup-card">
      <div class="aup-card-head">
        <div class="aup-card-info">
          <div class="aup-card-title">
            <!-- clock icon -->
            <svg class="aup-task-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
            {{ t("automations.taskNightlyPull") }}
          </div>
          <p class="aup-card-desc">{{ t("automations.taskNightlyPullDesc") }}</p>
          <span class="aup-trigger">
            {{ t("automations.taskNightlyPullTrigger").replace("{0}", formatNightlyTime()) }}
          </span>
          <!-- Time pickers (only visible when enabled) -->
          <div v-if="settings.automations.nightlyPull.enabled" class="aup-time-row">
            <label class="aup-time-label">
              {{ t("automations.taskNightlyPullHour") }}
              <input
                type="number"
                class="aup-time-input"
                :value="settings.automations.nightlyPull.hour"
                min="0" max="23"
                @change="setNightlyHour"
              />
            </label>
            <label class="aup-time-label">
              {{ t("automations.taskNightlyPullMinute") }}
              <input
                type="number"
                class="aup-time-input"
                :value="settings.automations.nightlyPull.minute"
                min="0" max="59"
                @change="setNightlyMinute"
              />
            </label>
          </div>
        </div>
        <label class="aup-toggle">
          <input
            type="checkbox"
            :checked="settings.automations.nightlyPull.enabled"
            @change="toggleNightlyPull"
          />
          <span class="aup-toggle-track"><span class="aup-toggle-thumb" /></span>
        </label>
      </div>
      <div class="aup-card-foot">
        <span class="aup-last-run">{{ lastRunLabel("nightlyPull") }}</span>
      </div>
    </div>

    <!-- ── Release notes ─────────────────────────────────── -->
    <div class="aup-card" :class="{ 'aup-card--requires-ai': !settings.aiEnabled }">
      <div class="aup-card-head">
        <div class="aup-card-info">
          <div class="aup-card-title">
            <!-- tag icon -->
            <svg class="aup-task-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
              <line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
            {{ t("automations.taskReleaseNotes") }}
          </div>
          <p class="aup-card-desc">{{ t("automations.taskReleaseNotesDesc") }}</p>
          <span class="aup-trigger">{{ t("automations.taskReleaseNotesTrigger") }}</span>
          <span v-if="!settings.aiEnabled" class="aup-requires-ai">{{ t("automations.requiresAi") }}</span>
        </div>
        <label class="aup-toggle">
          <input
            type="checkbox"
            :checked="settings.automations.releaseNotes.enabled"
            :disabled="!settings.aiEnabled"
            @change="toggleReleaseNotes"
          />
          <span class="aup-toggle-track"><span class="aup-toggle-thumb" /></span>
        </label>
      </div>
      <div class="aup-card-foot">
        <span class="aup-last-run">{{ lastRunLabel("releaseNotes") }}</span>
      </div>
    </div>

    <!-- ── AI commit batch ───────────────────────────────── -->
    <div class="aup-card" :class="{ 'aup-card--requires-ai': !settings.aiEnabled }">
      <div class="aup-card-head">
        <div class="aup-card-info">
          <div class="aup-card-title">
            <!-- sparkle icon -->
            <svg class="aup-task-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z"/>
            </svg>
            {{ t("automations.taskAiCommitBatch") }}
          </div>
          <p class="aup-card-desc">{{ t("automations.taskAiCommitBatchDesc") }}</p>
          <span class="aup-trigger">{{ t("automations.taskAiCommitBatchTrigger") }}</span>
          <span v-if="!settings.aiEnabled" class="aup-requires-ai">{{ t("automations.requiresAi") }}</span>
        </div>
        <label class="aup-toggle">
          <input
            type="checkbox"
            :checked="settings.automations.aiCommitBatch.enabled"
            :disabled="!settings.aiEnabled"
            @change="toggleAiCommitBatch"
          />
          <span class="aup-toggle-track"><span class="aup-toggle-thumb" /></span>
        </label>
      </div>
      <div class="aup-card-foot">
        <span class="aup-last-run">{{ lastRunLabel("aiCommitBatch") }}</span>
      </div>
    </div>

    <!-- ── Custom Rules ─────────────────────────────────── -->
    <div class="aup-section-head">
      <span class="aup-section-title">{{ t("automations.customRulesTitle") }}</span>
      <button class="aup-add-btn" @click="openAddForm">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        {{ t("automations.customRulesAdd") }}
      </button>
    </div>
    <p class="aup-section-desc">{{ t("automations.customRulesDesc") }}</p>

    <!-- Existing rules list -->
    <div v-for="rule in rules" :key="rule.id" class="aup-card aup-rule-card">
      <div class="aup-card-head">
        <div class="aup-card-info">
          <div class="aup-card-title">
            <!-- terminal icon -->
            <svg class="aup-task-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            {{ rule.name || rule.trigger }}
          </div>
          <span class="aup-trigger">{{ rule.trigger }}</span>
          <code class="aup-rule-cmd">$ {{ rule.command }}</code>
        </div>
        <div class="aup-rule-actions">
          <label class="aup-toggle">
            <input
              type="checkbox"
              :checked="rule.enabled"
              @change="toggleRule(rule.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="aup-toggle-track"><span class="aup-toggle-thumb" /></span>
          </label>
          <button class="aup-icon-btn" :title="t('automations.customRulesEdit')" @click="openEditForm(rule)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
              <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z"/>
            </svg>
          </button>
          <button class="aup-icon-btn aup-icon-btn--danger" :title="t('automations.customRulesDelete')" @click="deleteRule(rule.id)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
              <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5l.5-9"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <p v-if="rules.length === 0 && !showAddForm" class="aup-empty">
      {{ t("automations.customRulesEmpty") }}
    </p>

    <!-- Add / Edit form -->
    <div v-if="showAddForm" class="aup-form-card">
      <div class="aup-form-row">
        <label class="aup-form-label">{{ t("automations.customRulesFieldName") }}</label>
        <input v-model="form.name" class="aup-form-input" :placeholder="t('automations.customRulesFieldNamePlaceholder')" />
      </div>
      <div class="aup-form-row">
        <label class="aup-form-label">{{ t("automations.customRulesFieldTrigger") }}</label>
        <input v-model="form.trigger" class="aup-form-input" :placeholder="t('automations.customRulesFieldTriggerPlaceholder')" />
      </div>
      <div class="aup-form-row">
        <label class="aup-form-label">{{ t("automations.customRulesFieldCommand") }}</label>
        <input v-model="form.command" class="aup-form-input" :placeholder="t('automations.customRulesFieldCommandPlaceholder')" />
      </div>
      <div class="aup-form-row">
        <label class="aup-form-label">{{ t("automations.customRulesFieldCommit") }}</label>
        <input v-model="form.commitMessage" class="aup-form-input" :placeholder="t('automations.customRulesFieldCommitPlaceholder')" />
      </div>
      <div class="aup-form-footer">
        <button class="bm-btn bm-btn--ghost" @click="cancelForm">{{ t("common.cancel") }}</button>
        <button
          class="bm-btn bm-btn--primary"
          :disabled="!form.name.trim() || !form.trigger.trim() || !form.command.trim()"
          @click="submitForm"
        >{{ t("common.save") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aup-panel {
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Card ───────────────────────────────────────────────── */
.aup-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-alt, rgba(255,255,255,0.03));
  overflow: hidden;
  transition: border-color 0.12s;
}

.aup-card:hover {
  border-color: var(--color-accent);
}

.aup-card--requires-ai {
  opacity: 0.7;
}

.aup-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 14px 10px;
  gap: 12px;
}

.aup-card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.aup-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.aup-task-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.aup-card-desc {
  font-size: 11px;
  color: var(--color-text-secondary);
  line-height: 1.5;
  margin: 0;
}

.aup-trigger {
  font-size: 10px;
  font-weight: 500;
  color: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
  background: var(--color-surface, rgba(255,255,255,0.06));
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 1px 6px;
  display: inline-block;
  width: fit-content;
}

.aup-requires-ai {
  font-size: 11px;
  color: var(--color-warning, #d69e2e);
  font-style: italic;
}

.aup-card-foot {
  border-top: 1px solid var(--color-border);
  padding: 6px 14px;
  background: var(--color-bg-tertiary, rgba(0,0,0,0.06));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.aup-last-run {
  font-size: 10px;
  color: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
}

/* ── Time row ───────────────────────────────────────────── */
.aup-time-row {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}

.aup-time-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.aup-time-input {
  width: 52px;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: 11px;
  text-align: center;
}

.aup-time-input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}

/* ── Toggle switch ──────────────────────────────────────── */
.aup-toggle {
  position: relative;
  flex-shrink: 0;
  cursor: pointer;
  margin-top: 2px;
}

.aup-toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.aup-toggle-track {
  display: flex;
  align-items: center;
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--color-border);
  padding: 2px;
  transition: background 0.2s;
}

.aup-toggle input:checked ~ .aup-toggle-track {
  background: var(--color-accent, #6366f1);
}

.aup-toggle input:disabled ~ .aup-toggle-track {
  opacity: 0.4;
  cursor: not-allowed;
}

.aup-toggle-thumb {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: white;
  transition: transform 0.2s;
}

.aup-toggle input:checked ~ .aup-toggle-track .aup-toggle-thumb {
  transform: translateX(14px);
}

/* ── Custom rules section ───────────────────────────────── */
.aup-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-6);
}

/* Same look as SettingsPanel's .sp-section-label (accent bar on the left). */
.aup-section-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text);
  line-height: 1.2;
  padding-left: var(--space-4);
  border-left: 2px solid var(--color-accent);
}

.aup-section-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  margin: 0 0 4px;
  line-height: 1.5;
}

.aup-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent-text);
  background: var(--color-accent);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

/* Darken on hover rather than using --color-accent-hover: in the dark theme
   that token is a light violet (#a78bfa) and white text on it drops to
   ~2.7:1. Mixing in black keeps the label above 4.5:1 in both themes. */
.aup-add-btn:hover {
  background: color-mix(in srgb, var(--color-accent) 82%, #000);
  border-color: color-mix(in srgb, var(--color-accent) 82%, #000);
}

.aup-rule-card .aup-card-head {
  align-items: center;
}

.aup-rule-cmd {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary, rgba(0,0,0,0.06));
  border-radius: 3px;
  padding: 1px 5px;
  display: inline-block;
  width: fit-content;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aup-rule-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.aup-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.aup-icon-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.aup-icon-btn--danger:hover {
  background: var(--color-danger-soft, rgba(239,68,68,.12));
  color: var(--color-danger, #ef4444);
  border-color: var(--color-danger, #ef4444);
}

.aup-empty {
  font-size: 11px;
  color: var(--color-text-muted);
  font-style: italic;
  text-align: center;
  padding: 10px 0;
  margin: 0;
}

/* ── Inline add/edit form ───────────────────────────────── */
.aup-form-card {
  border: 1px solid var(--color-accent);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--color-accent-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.aup-form-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.aup-form-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.aup-form-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  background: #fff;
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: inherit;
  box-sizing: border-box;
}

.aup-form-input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}

.aup-form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>

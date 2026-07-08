<script setup lang="ts">
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import type { SecretFinding, SecretSeverity } from "@gitwand/core";

const props = defineProps<{
  findings: SecretFinding[];
}>();

const emit = defineEmits<{
  (e: "dismiss", key: string): void;
  (e: "ignore", patternId: string): void;
  (e: "commit-anyway"): void;
  (e: "close"): void;
}>();

const { t } = useI18n();

/** Mirrors `findingKey()` in useSecretsScanner.ts — stable per-finding identity. */
function findingKey(f: SecretFinding): string {
  return `${f.file}:${f.line}:${f.patternId}`;
}

const SEVERITY_LABEL_KEY: Record<SecretSeverity, "secrets.severityHigh" | "secrets.severityMedium" | "secrets.severityLow"> = {
  high: "secrets.severityHigh",
  medium: "secrets.severityMedium",
  low: "secrets.severityLow",
};

function severityLabel(s: SecretSeverity): string {
  return t(SEVERITY_LABEL_KEY[s]);
}
</script>

<template>
  <BaseModal
    :title="t('secrets.findingsTitle')"
    :subtitle="t('secrets.findingsSubtitle', props.findings.length)"
    size="lg"
    role="alertdialog"
    @close="emit('close')"
  >
    <div v-if="props.findings.length === 0" class="sfm-empty">{{ t('secrets.findingsEmpty') }}</div>
    <ul v-else class="sfm-list">
      <li v-for="f in props.findings" :key="findingKey(f)" class="sfm-item">
        <div class="sfm-item__main">
          <span class="sfm-item__chip" :class="`sfm-item__chip--${f.severity}`">{{ severityLabel(f.severity) }}</span>
          <span class="sfm-item__pattern mono">{{ f.patternId }}</span>
          <span class="sfm-item__location mono">{{ f.file }}:{{ f.line }}</span>
        </div>
        <div class="sfm-item__excerpt mono">{{ f.redactedExcerpt }}</div>
        <div class="sfm-item__actions">
          <button type="button" class="bm-btn bm-btn--ghost sfm-btn-compact sfm-item__dismiss" @click="emit('dismiss', findingKey(f))">
            {{ t('secrets.dismiss') }}
          </button>
          <button type="button" class="bm-btn bm-btn--ghost sfm-btn-compact sfm-item__ignore" @click="emit('ignore', f.patternId)">
            {{ t('secrets.ignorePattern') }}
          </button>
        </div>
      </li>
    </ul>

    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost sfm-footer-cancel" @click="emit('close')">
        {{ t('common.cancel') }}
      </button>
      <button type="button" class="bm-btn bm-btn--danger sfm-footer-commit" @click="emit('commit-anyway')">
        {{ t('secrets.commitAnyway') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.sfm-empty {
  color: var(--color-text-muted);
  text-align: center;
  padding: var(--space-6) 0;
}

.sfm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sfm-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.sfm-item__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.sfm-item__chip {
  flex-shrink: 0;
  padding: 2px var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  border-radius: var(--radius-sm);
  color: #fff;
}
.sfm-item__chip--high { background: var(--color-danger, #dc2626); }
.sfm-item__chip--medium { background: var(--color-warning, #d97706); }
.sfm-item__chip--low { background: var(--color-text-muted, #6e7681); }

.sfm-item__pattern {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.sfm-item__location {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sfm-item__excerpt {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  width: fit-content;
}

.sfm-item__actions {
  display: flex;
  gap: var(--space-2);
}

/* Flat, single-class modifier — never prefix `.bm-btn` with an ancestor selector like
   `.sfm-item__actions .bm-btn` (AGENTS.md modal-CSS rule): that raises specificity above
   `.bm-btn--ghost` / `.bm-btn--danger` and can make those modifiers silently lose. */
.sfm-btn-compact {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
}
</style>

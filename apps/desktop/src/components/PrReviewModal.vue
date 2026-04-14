<script setup lang="ts">
/**
 * PrReviewModal.vue
 *
 * Modal for submitting a complete PR review (Phase 9.3).
 * Allows the user to:
 *  - Choose a review type: Approve / Request Changes / Comment
 *  - Write an optional body (required for Request Changes)
 *  - See how many pending draft comments will be included
 *  - Submit the review via GitHub API
 */
import { ref, computed } from "vue";
import type { PendingReviewComment } from "../utils/backend";

const props = defineProps<{
  prNumber: number;
  /** Pending draft comments staged in this review. */
  draftComments: PendingReviewComment[];
  /** Whether the review is currently being submitted. */
  submitting?: boolean;
}>();

const emit = defineEmits<{
  /** User confirmed the review — parent calls ghPrSubmitReview then closes modal. */
  (e: "submit", opts: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    comments: PendingReviewComment[];
  }): void;
  (e: "close"): void;
}>();

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

const reviewEvent = ref<ReviewEvent>("COMMENT");
const body = ref("");

const canSubmit = computed(() => {
  if (props.submitting) return false;
  if (reviewEvent.value === "REQUEST_CHANGES" && !body.value.trim()) return false;
  return true;
});

const eventLabel: Record<ReviewEvent, string> = {
  APPROVE: "Approuver",
  REQUEST_CHANGES: "Demander des modifications",
  COMMENT: "Commenter",
};

const eventIcon: Record<ReviewEvent, string> = {
  APPROVE: "✅",
  REQUEST_CHANGES: "🔴",
  COMMENT: "💬",
};

function handleSubmit() {
  if (!canSubmit.value) return;
  emit("submit", {
    event: reviewEvent.value,
    body: body.value.trim(),
    comments: props.draftComments,
  });
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
</script>

<template>
  <div class="prm-overlay" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="prm-modal" role="dialog" aria-modal="true" aria-label="Soumettre la review">
      <!-- Header -->
      <div class="prm-header">
        <span class="prm-title">Review des modifications</span>
        <button class="prm-close" @click="emit('close')" title="Fermer">✕</button>
      </div>

      <!-- Draft comments summary -->
      <div v-if="draftComments.length > 0" class="prm-drafts">
        <span class="prm-drafts-icon">💬</span>
        <span>
          {{ draftComments.length }} commentaire{{ draftComments.length > 1 ? 's' : '' }}
          en attente seront inclus dans cette review
        </span>
      </div>
      <div v-else class="prm-drafts prm-drafts--empty">
        Aucun commentaire inline — vous pouvez soumettre une review globale uniquement.
      </div>

      <!-- Review type -->
      <div class="prm-section">
        <div class="prm-section-label">Type de review</div>
        <div class="prm-radio-group">
          <label
            v-for="ev in (['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as ReviewEvent[])"
            :key="ev"
            class="prm-radio-label"
            :class="{ 'prm-radio-label--active': reviewEvent === ev }"
          >
            <input
              type="radio"
              :value="ev"
              v-model="reviewEvent"
              class="prm-radio"
            />
            <span class="prm-radio-icon">{{ eventIcon[ev] }}</span>
            <span class="prm-radio-text">{{ eventLabel[ev] }}</span>
          </label>
        </div>
      </div>

      <!-- Body -->
      <div class="prm-section">
        <div class="prm-section-label">
          Message
          <span v-if="reviewEvent === 'REQUEST_CHANGES'" class="prm-required">(obligatoire)</span>
          <span v-else class="prm-optional">(optionnel)</span>
        </div>
        <textarea
          v-model="body"
          class="prm-textarea"
          rows="5"
          :placeholder="reviewEvent === 'APPROVE'
            ? 'Excellent travail ! Approuvé.'
            : reviewEvent === 'REQUEST_CHANGES'
              ? 'Décrivez les modifications demandées…'
              : 'Laissez un commentaire général…'"
          @keydown.ctrl.enter.prevent="handleSubmit"
          @keydown.meta.enter.prevent="handleSubmit"
        />
      </div>

      <!-- Actions -->
      <div class="prm-footer">
        <button class="prm-cancel-btn" @click="emit('close')">Annuler</button>
        <button
          class="prm-submit-btn"
          :class="`prm-submit-btn--${reviewEvent.toLowerCase().replace('_', '-')}`"
          :disabled="!canSubmit"
          @click="handleSubmit"
        >
          <span v-if="submitting">Envoi…</span>
          <span v-else>{{ eventIcon[reviewEvent] }} {{ eventLabel[reviewEvent] }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.prm-modal {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  width: 520px;
  max-width: 95vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-xl);
}

.prm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
}

.prm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.prm-close {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.prm-close:hover { color: var(--color-text); background: var(--color-bg-tertiary); }

/* Draft summary */
.prm-drafts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px 0;
  padding: 8px 12px;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent);
  border-radius: 6px;
  font-size: 12px;
  color: var(--color-text);
}
.prm-drafts--empty {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border);
  color: var(--color-text-muted);
}
.prm-drafts-icon { font-size: 14px; }

/* Sections */
.prm-section {
  padding: 14px 16px 0;
}

.prm-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
  display: flex;
  gap: 6px;
  align-items: center;
}

.prm-required { color: var(--color-danger); font-weight: 500; text-transform: none; }
.prm-optional { color: var(--color-text-muted); font-weight: 400; text-transform: none; }

/* Radio group */
.prm-radio-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prm-radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text);
  transition: border-color 0.15s, background 0.15s;
}
.prm-radio-label:hover { border-color: var(--color-accent); background: var(--color-accent-soft); }
.prm-radio-label--active { border-color: var(--color-accent); background: var(--color-accent-soft); }

.prm-radio { display: none; }
.prm-radio-icon { font-size: 15px; }
.prm-radio-text { font-weight: 500; }

/* Textarea */
.prm-textarea {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12px;
  padding: 8px 10px;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
  margin-top: 2px;
}
.prm-textarea:focus { outline: none; border-color: var(--color-accent); }

/* Footer */
.prm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--color-border);
  margin-top: 14px;
}

.prm-cancel-btn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
}
.prm-cancel-btn:hover { border-color: var(--color-text-muted); }

.prm-submit-btn {
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  color: var(--color-accent-text);
  background: var(--color-accent);
  transition: filter 0.15s;
}
.prm-submit-btn--approve { background: var(--color-success); color: var(--color-success-text); }
.prm-submit-btn--request-changes { background: var(--color-danger); color: var(--color-danger-text); }
.prm-submit-btn--comment { background: var(--color-accent); }
.prm-submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.prm-submit-btn:not(:disabled):hover { filter: brightness(1.1); }
</style>

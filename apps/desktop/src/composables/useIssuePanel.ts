/**
 * useIssuePanel.ts
 *
 * Singleton composable holding the in-app Issue detail state (v2.22).
 * Instantiated once in App.vue, provided via provide/inject so IssueDetailView
 * (in <main>) and App's Launchpad navigation share the same reactive state.
 *
 * Mirrors usePrPanel but much lighter: an issue has a body + a flat comment
 * thread + a binary open/closed state — no diff, checks, reviews, or merge.
 */
import { ref, computed, type Ref } from "vue";
import {
  ghIssueDetail,
  ghIssueComments,
  ghIssueAddComment,
  ghIssueSetState,
  type IssueDetail,
  type IssueComment,
} from "../utils/backend";

export const ISSUE_PANEL_KEY = Symbol("issuePanel");

export function useIssuePanel(cwd: Ref<string>) {
  const selectedNumber = ref<number | null>(null);
  const detail = ref<IssueDetail | null>(null);
  const comments = ref<IssueComment[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const newComment = ref("");
  const posting = ref(false);
  const mutating = ref(false);

  /** GitHub returns "open"/"closed" (REST) or "OPEN"/"CLOSED" (gh CLI). */
  const isOpen = computed(() => (detail.value?.state ?? "").toLowerCase() === "open");

  /** Load an issue's detail + comments. Guards against stale responses. */
  async function selectIssue(number: number): Promise<void> {
    selectedNumber.value = number;
    detail.value = null;
    comments.value = [];
    error.value = null;
    loading.value = true;
    try {
      const [d, c] = await Promise.all([
        ghIssueDetail(cwd.value, number),
        ghIssueComments(cwd.value, number).catch(() => [] as IssueComment[]),
      ]);
      // Ignore if the user navigated to another issue while this was in flight.
      if (selectedNumber.value !== number) return;
      detail.value = d;
      comments.value = c;
    } catch (e) {
      if (selectedNumber.value === number) error.value = (e as Error).message ?? String(e);
    } finally {
      if (selectedNumber.value === number) loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (selectedNumber.value != null) await selectIssue(selectedNumber.value);
  }

  /** Post `newComment` and append it optimistically to the thread. */
  async function addComment(): Promise<void> {
    const body = newComment.value.trim();
    if (!body || selectedNumber.value == null || posting.value) return;
    posting.value = true;
    error.value = null;
    try {
      const created = await ghIssueAddComment(cwd.value, selectedNumber.value, body);
      comments.value = [...comments.value, created];
      if (detail.value) detail.value.comments += 1;
      newComment.value = "";
    } catch (e) {
      error.value = (e as Error).message ?? String(e);
    } finally {
      posting.value = false;
    }
  }

  /** Close an open issue or reopen a closed one. */
  async function toggleState(): Promise<void> {
    if (!detail.value || selectedNumber.value == null || mutating.value) return;
    const next: "closed" | "open" = isOpen.value ? "closed" : "open";
    mutating.value = true;
    error.value = null;
    try {
      await ghIssueSetState(cwd.value, selectedNumber.value, next);
      detail.value = { ...detail.value, state: next };
    } catch (e) {
      error.value = (e as Error).message ?? String(e);
    } finally {
      mutating.value = false;
    }
  }

  return {
    selectedNumber,
    detail,
    comments,
    loading,
    error,
    newComment,
    posting,
    mutating,
    isOpen,
    selectIssue,
    refresh,
    addComment,
    toggleState,
  };
}

export type IssuePanelState = ReturnType<typeof useIssuePanel>;

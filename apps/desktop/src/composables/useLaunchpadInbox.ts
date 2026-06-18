import { ref, computed, type Ref } from "vue";
import { ghCurrentUser } from "../utils/backend";
import type { PrWithRepo } from "./useLaunchpadPrs";

/**
 * Inbox model for the Launchpad (v2.22) — "À traiter".
 *
 * Instead of listing *every* open PR (the firehose of the PRs tab), the inbox
 * surfaces only the PRs that require an action from the current user, grouped
 * by the action needed. This mirrors the focused review-inbox model (Linear
 * Diffs) while keeping GitWand's cross-repo + local-first angle.
 *
 * Priority order (a PR is classified into exactly one bucket):
 *   1. review  — someone requested *my* review (not a draft)
 *   2. changes — my own PR has changes requested
 *   3. ci      — my own PR has failing CI
 *   4. merge   — my own PR is approved and ready to merge
 */
export type InboxBucketKey = "review" | "changes" | "ci" | "merge";

export interface InboxBucket {
  key: InboxBucketKey;
  prs: PrWithRepo[];
}

/** Render order = priority order. */
export const INBOX_BUCKET_ORDER: InboxBucketKey[] = ["review", "changes", "ci", "merge"];

/**
 * Classify a single PR into an inbox bucket from the viewpoint of `me`.
 * Returns `null` when the PR needs no action from `me` (so it stays out of the
 * inbox). Exported for unit testing.
 */
export function classifyInboxPr(pr: PrWithRepo, me: string): InboxBucketKey | null {
  if (!me) return null;
  const isMine = pr.author === me;
  if (!isMine) {
    // Not my PR: it only lands in my inbox if my review is explicitly
    // requested — and never for drafts (not ready to look at yet).
    if (!pr.draft && pr.reviewRequested.includes(me)) return "review";
    return null;
  }
  // My own PR — what's the next thing I owe it?
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (pr.checksRollup === "FAILURE") return "ci";
  if (pr.reviewDecision === "APPROVED") return "merge";
  return null;
}

/**
 * Derive the action-grouped inbox from the flat list of open PRs.
 * `allPrs` is expected to already exclude snoozed items and front-load pinned
 * ones (it comes straight from {@link useLaunchpadPrs}), so the inbox inherits
 * that ordering inside each bucket for free.
 */
export function useLaunchpadInbox(allPrs: Ref<PrWithRepo[]>) {
  const currentUser = ref<string>("");

  /** Resolve the forge identity once (cached at the backend layer too). */
  async function loadUser(): Promise<void> {
    if (currentUser.value) return;
    try {
      currentUser.value = await ghCurrentUser();
    } catch {
      currentUser.value = "";
    }
  }

  const buckets = computed<InboxBucket[]>(() => {
    const me = currentUser.value;
    if (!me) return [];
    const grouped: Record<InboxBucketKey, PrWithRepo[]> = {
      review: [],
      changes: [],
      ci: [],
      merge: [],
    };
    for (const pr of allPrs.value) {
      const key = classifyInboxPr(pr, me);
      if (key) grouped[key].push(pr);
    }
    return INBOX_BUCKET_ORDER.map((key) => ({ key, prs: grouped[key] })).filter(
      (b) => b.prs.length > 0
    );
  });

  const totalCount = computed(() =>
    buckets.value.reduce((n, b) => n + b.prs.length, 0)
  );

  return { currentUser, loadUser, buckets, totalCount };
}

import { ref, computed, type Ref } from "vue";
import { ghCurrentUser } from "../utils/backend";
import type { PrWithRepo } from "./useLaunchpadPrs";

/**
 * Inbox model for the Launchpad (v2.29) — triaged action inbox.
 *
 * Three urgency tiers replace the flat bucket list:
 *   now     — "À traiter"  — requires immediate action from me
 *   waiting — "En attente" — waiting on someone/something else
 *   later   — "Plus tard"  — low-priority (dep bumps etc.)
 *
 * Priority order within the "now" tier (first match wins):
 *   1. review    — someone requested *my* review (not a draft)
 *   2. changes   — my own PR has changes requested
 *   3. conflicts — my own PR has merge conflicts (DIRTY)
 *   4. ci        — my own PR has failing CI
 *   5. merge     — my own PR is approved and ready to merge
 */
export type InboxTier = "now" | "waiting" | "later";

export type InboxCase =
  | "review"      // review requested of me
  | "changes"     // changes requested on my PR
  | "conflicts"   // my PR has merge conflicts (mergeStateStatus === "DIRTY")
  | "ci"          // my PR has failing CI
  | "merge"       // my PR is approved and ready to merge
  | "waiting"     // my PR is awaiting others' review
  | "ciRunning"   // my PR has a CI run in progress
  | "blocked";    // my PR is approved but branch protection blocks merge

export type InboxAction =
  | "merge"
  | "review"
  | "seeFailure"
  | "reply"
  | "resolve"
  | "follow"
  | "nudge"
  | "autoMerge";

export interface InboxClassification {
  tier: InboxTier;
  case: InboxCase;
  action: InboxAction;
}

export interface InboxItem {
  pr: PrWithRepo;
  classification: InboxClassification;
}

export interface InboxTierGroup {
  tier: InboxTier;
  items: InboxItem[];
}

/** Render order = urgency order. */
export const TIER_ORDER: InboxTier[] = ["now", "waiting", "later"];

/** Dependency-bump heuristic: author matches bot pattern OR labels include "dependencies". */
function isDependencyBump(pr: PrWithRepo): boolean {
  const botPattern = /^(dependabot|renovate)(\[bot\])?$/i;
  return botPattern.test(pr.author) || pr.labels.includes("dependencies");
}

/**
 * Classify a single PR into a tier + case + action from the viewpoint of `me`.
 * Returns `null` when the PR needs no action from `me` (so it stays out of the inbox).
 * Decision table is evaluated top-to-bottom, first match wins.
 * Exported for unit testing.
 */
export function classifyInboxPr(pr: PrWithRepo, me: string): InboxClassification | null {
  if (!me) return null;

  const isMine = pr.author === me;

  // Not my PR: only lands in my inbox if my review is explicitly requested
  // and it's not a draft.
  if (!isMine) {
    if (!pr.draft && pr.reviewRequested.includes(me)) {
      return { tier: "now", case: "review", action: "review" };
    }
    return null;
  }

  // My own PR — what's the next thing I owe it?

  // 1. Changes requested — highest priority for own PRs
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { tier: "now", case: "changes", action: "reply" };
  }

  // 2. Merge conflicts (DIRTY) — can't merge until resolved
  if (pr.mergeStateStatus === "DIRTY") {
    return { tier: "now", case: "conflicts", action: "resolve" };
  }

  // 3. Failing CI
  if (pr.checksRollup === "FAILURE") {
    return { tier: "now", case: "ci", action: "seeFailure" };
  }

  // 4. Approved — ready to merge (or blocked / dirty)
  if (pr.reviewDecision === "APPROVED") {
    // Dependency bump → demote to later tier
    if (isDependencyBump(pr)) {
      return { tier: "later", case: "merge", action: "autoMerge" };
    }
    // Blocked by branch protection → waiting
    if (pr.mergeStateStatus === "BLOCKED") {
      return { tier: "waiting", case: "blocked", action: "follow" };
    }
    // CLEAN, HAS_HOOKS, or empty → merge now
    return { tier: "now", case: "merge", action: "merge" };
  }

  // 5. CI is running — waiting
  if (pr.checksRollup === "PENDING") {
    return { tier: "waiting", case: "ciRunning", action: "follow" };
  }

  // 6. Awaiting review from others
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return { tier: "waiting", case: "waiting", action: "follow" };
  }

  return null;
}

/**
 * Derive the tiered inbox from the flat list of open PRs.
 * `allPrs` is expected to already exclude snoozed items and front-load pinned
 * ones (it comes straight from {@link useLaunchpadPrs}), so the inbox inherits
 * that ordering inside each tier for free.
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

  const tiers = computed<InboxTierGroup[]>(() => {
    const me = currentUser.value;
    if (!me) return [];

    const grouped: Record<InboxTier, InboxItem[]> = {
      now: [],
      waiting: [],
      later: [],
    };

    for (const pr of allPrs.value) {
      const classification = classifyInboxPr(pr, me);
      if (classification) {
        grouped[classification.tier].push({ pr, classification });
      }
    }

    return TIER_ORDER.map((tier) => ({ tier, items: grouped[tier] })).filter(
      (g) => g.items.length > 0
    );
  });

  const totalCount = computed(() =>
    tiers.value.reduce((n, g) => n + g.items.length, 0)
  );

  const nowCount = computed(() => {
    const nowGroup = tiers.value.find((g) => g.tier === "now");
    return nowGroup ? nowGroup.items.length : 0;
  });

  return { currentUser, loadUser, tiers, nowCount, totalCount };
}

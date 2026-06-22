import { ref, computed, type Ref } from "vue";
import { ghCurrentUser } from "../utils/backend";
import type { PrWithRepo } from "./useLaunchpadPrs";
import type { IssueWithRepo } from "./useLaunchpadIssues";
import type { LocaleKey } from "../locales";

/**
 * Inbox model for the Today view (v2.29) — fixed-section scrolling inbox.
 *
 * Six fixed sections replace the filter-chips + group-by model:
 *   1. repos   — local action cards (commit / push / sync), inserted by the view
 *   2. mine    — non-dep PRs I authored
 *   3. assigned — non-dep PRs where I'm an assignee but NOT the author / review-requested
 *   4. review  — non-dep PRs where my review is requested
 *   5. issues  — issues assigned to me
 *   6. deps    — dependency-bump PRs reaching me via review-requested or assignee
 *
 * Classification precedence for a PR (first match wins):
 *   1. isDependencyBump → deps
 *   2. author === me    → mine
 *   3. reviewRequested  → review
 *   4. assignees        → assigned
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
  | "blocked"     // my PR is approved but branch protection blocks merge
  | "assigned"    // a PR assigned to me (not author, review not requested)
  | "issue";      // issue assigned/mentioned/created

export type InboxAction =
  | "merge"
  | "review"
  | "seeFailure"
  | "reply"
  | "resolve"
  | "follow"
  | "nudge"
  | "autoMerge"
  | "view";       // open an issue / dep / assigned PR

/** Discriminated union of items that can appear in the unified inbox. */
export type InboxEntityKind = "pr" | "issue" | "dep";

export interface InboxClassification {
  tier: InboxTier;
  case: InboxCase;
  action: InboxAction;
  /** What type of entity is this (drives section routing). */
  kind: InboxEntityKind;
}

export interface InboxItem {
  /** For PR/dep items. Undefined for issues. */
  pr?: PrWithRepo;
  /** For issue items. Undefined for PRs. */
  issue?: IssueWithRepo;
  classification: InboxClassification;
}

/** A named section of inbox items (returned by sections). */
export interface InboxSection {
  /** Stable key for v-for. One of: mine | assigned | review | issues | deps */
  key: string;
  /** i18n key for the section title header, e.g. "launchpad.section.mine". */
  titleKey: LocaleKey;
  count: number;
  items: InboxItem[];
}

/** Render order = urgency order (kept for nowCount). */
export const TIER_ORDER: InboxTier[] = ["now", "waiting", "later"];

/** Dependency-bump heuristic: author matches bot pattern OR labels include "dependencies". */
function isDependencyBump(pr: PrWithRepo): boolean {
  const botPattern = /^(dependabot|renovate)(\[bot\])?$/i;
  // Label match is case-insensitive: GitHub's default is "dependencies" but
  // repos commonly use "Dependencies".
  return botPattern.test(pr.author) || pr.labels.some((l) => l.toLowerCase() === "dependencies");
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
  const reviewRequested = pr.reviewRequested.includes(me);
  const isAssigned = (pr.assignees ?? []).includes(me);

  // Dep-bump PRs (dependabot/renovate author or "dependencies" label) are
  // classified as kind:"dep" if they surface to me at all — i.e.
  // if I own the PR, my review was requested, or I am an assignee.
  if (isDependencyBump(pr) && (isMine || reviewRequested || isAssigned)) {
    return { tier: "later", case: "merge", action: "autoMerge", kind: "dep" };
  }

  // My own PR — what's the next thing I owe it?
  if (isMine) {
    // 1. Changes requested — highest priority for own PRs
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      return { tier: "now", case: "changes", action: "reply", kind: "pr" };
    }

    // 2. Merge conflicts (DIRTY) — can't merge until resolved
    if (pr.mergeStateStatus === "DIRTY") {
      return { tier: "now", case: "conflicts", action: "resolve", kind: "pr" };
    }

    // 3. Failing CI
    if (pr.checksRollup === "FAILURE") {
      return { tier: "now", case: "ci", action: "seeFailure", kind: "pr" };
    }

    // 4. Approved — ready to merge (or blocked / dirty)
    if (pr.reviewDecision === "APPROVED") {
      // Blocked by branch protection → waiting
      if (pr.mergeStateStatus === "BLOCKED") {
        return { tier: "waiting", case: "blocked", action: "follow", kind: "pr" };
      }
      // CLEAN, HAS_HOOKS, or empty → merge now
      return { tier: "now", case: "merge", action: "merge", kind: "pr" };
    }

    // 5. CI is running — waiting
    if (pr.checksRollup === "PENDING") {
      return { tier: "waiting", case: "ciRunning", action: "follow", kind: "pr" };
    }

    // 6. Awaiting review from others
    if (pr.reviewDecision === "REVIEW_REQUIRED") {
      return { tier: "waiting", case: "waiting", action: "follow", kind: "pr" };
    }

    return null;
  }

  // Not my PR: review-requested wins over assignee-only
  if (!pr.draft && reviewRequested) {
    return { tier: "now", case: "review", action: "review", kind: "pr" };
  }

  // Assigned to me (not author, not review-requested): actionable via "view"
  if (isAssigned) {
    return { tier: "now", case: "assigned", action: "view", kind: "pr" };
  }

  return null;
}

/**
 * Classify an issue into a tier + case + action.
 * The inbox shows assigned issues (actionable set).
 * Exported for unit testing.
 */
export function classifyIssue(issue: IssueWithRepo): InboxClassification {
  return { tier: "now", case: "issue", action: "view", kind: "issue" };
}

/**
 * Section key for a classified PR item.
 * Precedence: dep → mine → review → assigned
 */
function prSectionKey(classification: InboxClassification, pr: PrWithRepo, me: string): string {
  if (classification.kind === "dep") return "deps";
  if (pr.author === me) return "mine";
  if (classification.case === "review") return "review";
  return "assigned";
}

/** Fixed section order and their i18n title keys. */
const SECTION_ORDER: Array<{ key: string; titleKey: LocaleKey }> = [
  { key: "mine",     titleKey: "launchpad.section.mine" },
  { key: "assigned", titleKey: "launchpad.section.assigned" },
  { key: "review",   titleKey: "launchpad.section.review" },
  { key: "issues",   titleKey: "launchpad.section.issues" },
  { key: "deps",     titleKey: "launchpad.section.deps" },
];

/**
 * Derive the fixed-section inbox from the flat list of open PRs plus issues.
 * `allPrs` is expected to already exclude snoozed items and front-load pinned
 * ones (it comes straight from {@link useLaunchpadPrs}), so the inbox inherits
 * that ordering inside each section for free.
 *
 * @param allPrs   Reactive ref from useLaunchpadPrs
 * @param allIssues  Reactive ref from useLaunchpadIssues (optional)
 */
export function useLaunchpadInbox(
  allPrs: Ref<PrWithRepo[]>,
  allIssues?: Ref<IssueWithRepo[]>
) {
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

  /** All classified items (PR + issue union), memoized. */
  const allItems = computed<InboxItem[]>(() => {
    const me = currentUser.value;
    if (!me) return [];

    const items: InboxItem[] = [];

    // Classify PRs
    for (const pr of allPrs.value) {
      const classification = classifyInboxPr(pr, me);
      if (classification) {
        items.push({ pr, classification });
      }
    }

    // Classify issues
    for (const issue of (allIssues?.value ?? [])) {
      const classification = classifyIssue(issue);
      items.push({ issue, classification });
    }

    return items;
  });

  /**
   * Ordered, non-empty sections for the fixed-section inbox view.
   * Sections not represented by any item are omitted.
   * The "repos" section (local action cards) is NOT included here —
   * it is prepended by the view from useRepoActionCards.
   */
  const sections = computed<InboxSection[]>(() => {
    const me = currentUser.value;
    if (!me) return [];

    const buckets = new Map<string, InboxItem[]>(
      SECTION_ORDER.map((s) => [s.key, []])
    );

    for (const item of allItems.value) {
      if (item.pr) {
        const key = prSectionKey(item.classification, item.pr, me);
        buckets.get(key)?.push(item);
      } else if (item.issue) {
        buckets.get("issues")?.push(item);
      }
    }

    return SECTION_ORDER
      .filter((s) => (buckets.get(s.key)?.length ?? 0) > 0)
      .map((s) => ({
        key: s.key,
        titleKey: s.titleKey,
        count: buckets.get(s.key)!.length,
        items: buckets.get(s.key)!,
      }));
  });

  const totalCount = computed(() => allItems.value.length);

  const nowCount = computed(() => {
    return allItems.value.filter((i) => i.classification.tier === "now").length;
  });

  return {
    currentUser,
    loadUser,
    sections,
    nowCount,
    totalCount,
    allItems,
  };
}

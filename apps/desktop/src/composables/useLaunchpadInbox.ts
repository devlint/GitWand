import { ref, computed, type Ref } from "vue";
import { ghCurrentUser } from "../utils/backend";
import type { PrWithRepo } from "./useLaunchpadPrs";
import type { IssueWithRepo } from "./useLaunchpadIssues";

/**
 * Inbox model for the Today view (v2.29) — triaged action inbox (Phase 2).
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
 *
 * Phase 2 adds:
 *   - Union item model: pr | issue | dep | local (assigned issues from useLaunchpadIssues)
 *   - Filter chips (all / mine / review / issues / deps)
 *   - Group-by toggle (priority / repo / type)
 *   - Issues set = assigned issues only (actionable); Phase 3 will add mentioned/@-authored
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
  | "view";       // open an issue / dep

/** Discriminated union of items that can appear in the unified inbox. */
export type InboxEntityKind = "pr" | "issue" | "dep";

export interface InboxClassification {
  tier: InboxTier;
  case: InboxCase;
  action: InboxAction;
  /** What type of entity is this (drives filter chips). */
  kind: InboxEntityKind;
}

export interface InboxItem {
  /** For PR/dep items. Undefined for issues. */
  pr?: PrWithRepo;
  /** For issue items. Undefined for PRs. */
  issue?: IssueWithRepo;
  classification: InboxClassification;
}

/** A named group of inbox items (returned by groupedItems). */
export interface InboxGroup {
  /** Stable key for v-for. */
  key: string;
  /** i18n key-compatible label token (resolved in the view with t()). */
  label: string;
  count: number;
  items: InboxItem[];
}

/** Legacy-compat tier group (used by Phase-1 tier rendering). */
export interface InboxTierGroup {
  tier: InboxTier;
  items: InboxItem[];
}

/** Active filter for the unified inbox. */
export type InboxFilter = "all" | "mine" | "review" | "issues" | "deps";

/** Group-by mode for the unified inbox. */
export type InboxGroupBy = "priority" | "repo" | "type";

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
  const reviewRequested = pr.reviewRequested.includes(me);

  // Dep-bump PRs (dependabot/renovate author or "dependencies" label) are
  // classified as kind:"dep" tier:"later" if they surface to me at all, i.e.
  // if I own the PR OR my review was requested. Unrelated bot PRs that have
  // nothing to do with me are filtered out as usual.
  if (isDependencyBump(pr) && (isMine || reviewRequested)) {
    return { tier: "later", case: "merge", action: "autoMerge", kind: "dep" };
  }

  // Not my PR: only lands in my inbox if my review is explicitly requested
  // and it's not a draft.
  if (!isMine) {
    if (!pr.draft && reviewRequested) {
      return { tier: "now", case: "review", action: "review", kind: "pr" };
    }
    return null;
  }

  // My own PR — what's the next thing I owe it?

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

/**
 * Classify an issue into a tier + case + action.
 * Phase 2: the inbox shows assigned issues only (actionable set).
 * Phase 3 will extend this to mentioned/@-authored issues.
 * Exported for unit testing.
 */
export function classifyIssue(issue: IssueWithRepo): InboxClassification {
  return { tier: "now", case: "issue", action: "view", kind: "issue" };
}

/**
 * Derive the tiered inbox from the flat list of open PRs plus issues.
 * `allPrs` is expected to already exclude snoozed items and front-load pinned
 * ones (it comes straight from {@link useLaunchpadPrs}), so the inbox inherits
 * that ordering inside each tier for free.
 *
 * @param allPrs   Reactive ref from useLaunchpadPrs
 * @param allIssues  Reactive ref from useLaunchpadIssues (optional — Phase 2)
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

    // Classify issues (Phase 2)
    for (const issue of (allIssues?.value ?? [])) {
      const classification = classifyIssue(issue);
      items.push({ issue, classification });
    }

    return items;
  });

  /** Group by tier (legacy-compat + default group-by). */
  const tiers = computed<InboxTierGroup[]>(() => {
    const grouped: Record<InboxTier, InboxItem[]> = {
      now: [],
      waiting: [],
      later: [],
    };

    for (const item of allItems.value) {
      grouped[item.classification.tier].push(item);
    }

    return TIER_ORDER.map((tier) => ({ tier, items: grouped[tier] })).filter(
      (g) => g.items.length > 0
    );
  });

  const totalCount = computed(() => allItems.value.length);

  const nowCount = computed(() => {
    return allItems.value.filter((i) => i.classification.tier === "now").length;
  });

  /**
   * Live counts per filter chip.
   * Issues/mentions counts are only non-zero when allIssues is wired (Phase 2).
   */
  const filterCounts = computed<Record<InboxFilter, number>>(() => {
    const me = currentUser.value;
    const items = allItems.value;
    return {
      all: items.length,
      mine: items.filter((i) => i.pr && i.pr.author === me && i.classification.kind !== "dep").length,
      review: items.filter((i) => i.classification.case === "review").length,
      issues: items.filter((i) => i.classification.kind === "issue").length,
      deps: items.filter((i) => i.classification.kind === "dep").length,
    };
  });

  /**
   * Apply a filter to the item set.
   */
  function applyFilter(filter: InboxFilter): InboxItem[] {
    const me = currentUser.value;
    const items = allItems.value;
    switch (filter) {
      case "mine":
        return items.filter((i) => i.pr && i.pr.author === me && i.classification.kind !== "dep");
      case "review":
        return items.filter((i) => i.classification.case === "review");
      case "issues":
        return items.filter((i) => i.classification.kind === "issue");
      case "deps":
        return items.filter((i) => i.classification.kind === "dep");
      case "all":
      default:
        return items;
    }
  }

  /**
   * Return grouped items for the given group-by mode and filter.
   * Each group has a stable key, a label token, a count, and its items.
   */
  function groupedItems(groupBy: InboxGroupBy, filter: InboxFilter): InboxGroup[] {
    const filtered = applyFilter(filter);

    switch (groupBy) {
      case "repo": {
        const byRepo = new Map<string, InboxItem[]>();
        for (const item of filtered) {
          const repoName = item.pr?.repoName ?? item.issue?.repoName ?? "unknown";
          if (!byRepo.has(repoName)) byRepo.set(repoName, []);
          byRepo.get(repoName)!.push(item);
        }
        return Array.from(byRepo.entries()).map(([repoName, items]) => ({
          key: `repo:${repoName}`,
          label: repoName,
          count: items.length,
          items,
        }));
      }

      case "type": {
        const byType = new Map<InboxEntityKind, InboxItem[]>([
          ["pr", []],
          ["issue", []],
          ["dep", []],
        ]);
        for (const item of filtered) {
          byType.get(item.classification.kind)!.push(item);
        }
        const typeOrder: InboxEntityKind[] = ["pr", "issue", "dep"];
        return typeOrder
          .filter((k) => (byType.get(k)?.length ?? 0) > 0)
          .map((k) => ({
            key: `type:${k}`,
            // label token resolved by view: t(`launchpad.typeGroup.${k}`)
            label: k,
            count: byType.get(k)!.length,
            items: byType.get(k)!,
          }));
      }

      case "priority":
      default: {
        const grouped: Record<InboxTier, InboxItem[]> = { now: [], waiting: [], later: [] };
        for (const item of filtered) {
          grouped[item.classification.tier].push(item);
        }
        return TIER_ORDER.filter((t) => grouped[t].length > 0).map((t) => ({
          key: `tier:${t}`,
          // label token resolved by view: t(`launchpad.tier.${t}`)
          label: t,
          count: grouped[t].length,
          items: grouped[t],
        }));
      }
    }
  }

  return {
    currentUser,
    loadUser,
    tiers,
    nowCount,
    totalCount,
    filterCounts,
    groupedItems,
    allItems,
  };
}

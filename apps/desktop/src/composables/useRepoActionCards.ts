import { computed, type Ref } from "vue";
import type { WorkspaceWipItem } from "../utils/backend";

/**
 * Local action cards for the Launchpad inbox-journal (v3) — the generalisation
 * of DashboardView's single `nextAction` into a per-repo feed. Reads the
 * cross-repo WIP state and emits every applicable local action, so the morning
 * journal shows "what's mine to push/commit" next to the PR/issue buckets.
 *
 * One repo can yield several cards (e.g. changes to commit AND commits to push).
 * No "conflict" card: WIP carries no conflicted count — conflicts surface once
 * you're inside the repo's Changes view.
 *
 * This is one pluggable card *source*; the PR buckets (useLaunchpadInbox) are
 * another, and a future "stack" source will slot in the same way.
 */
export type RepoCardKind = "commit" | "push" | "publish" | "sync";

export interface RepoActionCard {
  /** Stable id for v-for keys. */
  id: string;
  kind: RepoCardKind;
  repoName: string;
  repoPath: string;
  /** Count relevant to the kind: changes for commit, commits ahead/behind for push/sync. */
  count: number;
}

const PRIORITY: Record<RepoCardKind, number> = {
  commit: 0,
  push: 1,
  publish: 2,
  sync: 3,
};

export function useRepoActionCards(wip: Ref<WorkspaceWipItem[]>) {
  const cards = computed<RepoActionCard[]>(() => {
    const out: RepoActionCard[] = [];
    for (const w of wip.value) {
      if (w.error) continue;
      const changes = w.stagedCount + w.unstagedCount + w.untrackedCount;
      if (changes > 0) {
        out.push({ id: `${w.path}:commit`, kind: "commit", repoName: w.name, repoPath: w.path, count: changes });
      }
      if (w.hasNoUpstream) {
        out.push({ id: `${w.path}:publish`, kind: "publish", repoName: w.name, repoPath: w.path, count: 0 });
      } else {
        if (w.ahead > 0) {
          out.push({ id: `${w.path}:push`, kind: "push", repoName: w.name, repoPath: w.path, count: w.ahead });
        }
        if (w.behind > 0) {
          out.push({ id: `${w.path}:sync`, kind: "sync", repoName: w.name, repoPath: w.path, count: w.behind });
        }
      }
    }
    return out.sort((a, b) => {
      const p = PRIORITY[a.kind] - PRIORITY[b.kind];
      return p !== 0 ? p : a.repoName.localeCompare(b.repoName);
    });
  });

  const totalCount = computed(() => cards.value.length);

  return { cards, totalCount };
}

/**
 * v3.11.1 — Render a `HunkHistory` as a prompt section, within a token budget.
 *
 * Truncation order, applied one item at a time until the text fits:
 *   1. range diffs, oldest commit first (the newest commit's diff on each side goes last)
 *   2. message bodies, oldest first
 *   3. whole commits, oldest first
 * The newest commit's short SHA + subject on each `ok` side is never dropped,
 * nor is any "History unavailable" line. If those alone exceed the budget
 * they are still sent and the stats say `truncated`.
 */

import type {
  HistoryCommit,
  HistoryRefs,
  HistoryStats,
  HistoryUnavailableReason,
  HunkHistory,
  SideHistory,
} from "./types.js";

export interface HistoryLabels {
  ours: string;
  theirs: string;
}

const OPERATION_HEAD: Record<NonNullable<HistoryRefs["operation"]>, string> = {
  merge: "MERGE_HEAD",
  rebase: "REBASE_HEAD",
  "cherry-pick": "CHERRY_PICK_HEAD",
  revert: "REVERT_HEAD",
};

export function historyLabels(operation?: HistoryRefs["operation"]): HistoryLabels {
  if (!operation) return { ours: "ours", theirs: "theirs" };
  return { ours: "ours (HEAD)", theirs: `theirs (${OPERATION_HEAD[operation]})` };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const REASON_TEXT: Record<HistoryUnavailableReason, string> = {
  "no-sha": "the commits of the operation could not be identified",
  "no-merge-base": "the two sides share no merge base",
  "side-deleted": "this side removed these lines, and no commit since the merge base explains it",
  "locate-failed": "these lines could not be located in this side's version of the file",
  "no-commits": "no commit changed these lines since the merge base",
  timeout: "git did not answer in time",
  "git-error": "git could not read this side's history",
};

interface Item {
  commit: HistoryCommit;
  diff: boolean;
  body: boolean;
  kept: boolean;
}

interface SideModel {
  side: SideHistory;
  label: string;
  items: Item[];
}

function renderCommit(item: Item): string {
  const { commit } = item;
  let out = `- ${commit.sha.slice(0, 7)} ${commit.date} ${commit.author}: ${commit.subject}`;
  if (item.body && commit.body) out += "\n" + commit.body.split("\n").map((l) => `  ${l}`).join("\n");
  if (item.diff && commit.rangeDiff) out += "\n  ```diff\n" + commit.rangeDiff.split("\n").map((l) => `  ${l}`).join("\n") + "\n  ```";
  return out;
}

function renderSide(model: SideModel): string {
  const lines = [`### ${model.label}`];
  if (model.side.status === "unavailable") {
    lines.push(`History unavailable: ${REASON_TEXT[model.side.reason ?? "git-error"]}.`);
    return lines.join("\n");
  }
  if (model.side.reason === "side-deleted") lines.push("This side removed these lines. Commits that touched the file:");
  for (const item of model.items) if (item.kept) lines.push(renderCommit(item));
  return lines.join("\n");
}

function renderAll(mergeBase: string | null, models: SideModel[]): string {
  const header = mergeBase
    ? `## Why each side changed these lines (since merge-base ${mergeBase.slice(0, 7)}):`
    : "## Why each side changed these lines:";
  return [header, ...models.map(renderSide)].join("\n");
}

/** Items of both sides, oldest first, with each side's newest commit (index 0) last. */
function oldestFirst(models: SideModel[]): Item[] {
  const maxLen = Math.max(0, ...models.map((m) => m.items.length));
  const out: Item[] = [];
  for (let idx = maxLen - 1; idx >= 0; idx--) {
    for (const m of models) if (m.items[idx]) out.push(m.items[idx]);
  }
  return out;
}

export function renderHistorySection(
  history: HunkHistory,
  budgetTokens: number,
  labels: HistoryLabels = historyLabels(undefined),
): { text: string; stats: HistoryStats } {
  const models: SideModel[] = [
    { side: history.ours, label: labels.ours, items: [] },
    { side: history.theirs, label: labels.theirs, items: [] },
  ];
  for (const m of models) {
    if (m.side.status === "ok") {
      m.items = m.side.commits.map((commit) => ({ commit, diff: true, body: true, kept: true }));
    }
  }

  let text = renderAll(history.mergeBase, models);
  let truncated = false;
  const fits = () => estimateTokens(text) <= budgetTokens;
  const order = oldestFirst(models);

  const steps: Array<(item: Item) => boolean> = [
    (item) => (item.diff && item.commit.rangeDiff ? ((item.diff = false), true) : false),
    (item) => (item.body && item.commit.body ? ((item.body = false), true) : false),
    (item) => {
      const isNewest = models.some((m) => m.items[0] === item);
      return !isNewest && item.kept ? ((item.kept = false), true) : false;
    },
  ];

  for (const step of steps) {
    for (const item of order) {
      if (fits()) break;
      if (step(item)) {
        truncated = true;
        text = renderAll(history.mergeBase, models);
      }
    }
  }
  if (!fits()) truncated = true;

  const reasons: HistoryUnavailableReason[] = [];
  for (const m of models) if (m.side.reason && !reasons.includes(m.side.reason)) reasons.push(m.side.reason);
  const anyOk = models.some((m) => m.side.status === "ok");
  const commitCount = models.reduce((n, m) => n + m.items.filter((i) => i.kept).length, 0);

  return {
    text,
    stats: {
      status: !anyOk ? "unavailable" : truncated ? "truncated" : "included",
      reasons,
      commitCount,
      estTokens: estimateTokens(text),
    },
  };
}

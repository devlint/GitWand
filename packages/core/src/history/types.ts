/**
 * v3.11.1 — History-aware LLM fallback: shared types.
 *
 * Browser-safe: no Node.js import. Git is reached only through an injected
 * `GitRunner`, the same way the LLM is reached through `LlmEndpoint`.
 */

import type { MergeContext } from "../types.js";

/**
 * Runs `git <args>` in the repository root and resolves with its stdout and
 * exit code. Must never reject on a non-zero exit; it may reject on a spawn
 * failure, which `collectHunkHistory` turns into `git-error`.
 */
export type GitRunner = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

export interface HistoryCommit {
  /** Full SHA. Rendered short. */
  sha: string;
  author: string;
  /** YYYY-MM-DD */
  date: string;
  subject: string;
  body: string;
  /** `git log -L` patch limited to the hunk range; "" for the file-level fallback. */
  rangeDiff: string;
}

export type HistoryUnavailableReason =
  | "no-sha"
  | "no-merge-base"
  | "side-deleted"
  | "locate-failed"
  | "no-commits"
  | "timeout"
  | "git-error";

export interface SideHistory {
  status: "ok" | "unavailable";
  /** Always set when `unavailable`. Also set to `side-deleted` on an `ok` file-level fallback. */
  reason?: HistoryUnavailableReason;
  /** Newest first. */
  commits: HistoryCommit[];
}

export interface HunkHistory {
  mergeBase: string | null;
  ours: SideHistory;
  theirs: SideHistory;
}

export interface HistoryConfig {
  enabled: boolean;
  budgetTokens: number;
}

export const HISTORY_BUDGET_MIN = 200;
export const HISTORY_BUDGET_MAX = 8000;
/** Frozen: shared by reference, spread it to get a mutable copy. */
export const DEFAULT_HISTORY_CONFIG: Readonly<HistoryConfig> = Object.freeze({ enabled: true, budgetTokens: 1500 });

export type HistoryStatsStatus = "included" | "truncated" | "unavailable" | "disabled";

export interface HistoryStats {
  status: HistoryStatsStatus;
  reasons: HistoryUnavailableReason[];
  commitCount: number;
  estTokens: number;
}

/**
 * Frozen (its `reasons` too): shared by reference, so a trace that needs a
 * mutable `HistoryStats` takes `{ ...DISABLED_HISTORY_STATS, reasons: [] }`.
 */
export const DISABLED_HISTORY_STATS: Readonly<Omit<HistoryStats, "reasons">> & {
  readonly reasons: readonly HistoryUnavailableReason[];
} = Object.freeze({
  status: "disabled",
  reasons: Object.freeze([] as HistoryUnavailableReason[]),
  commitCount: 0,
  estTokens: 0,
});

export interface HistoryRefs {
  operation?: MergeContext["operation"];
  oursSha?: string;
  theirsSha?: string;
}

export function clampHistoryBudget(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_CONFIG.budgetTokens;
  return Math.min(HISTORY_BUDGET_MAX, Math.max(HISTORY_BUDGET_MIN, Math.round(n)));
}

/** Validates a raw `llmFallback.history` block from `.gitwandrc`. */
export function normalizeHistoryConfig(raw: unknown): Partial<HistoryConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<HistoryConfig> = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.budgetTokens === "number" && Number.isFinite(r.budgetTokens)) {
    out.budgetTokens = clampHistoryBudget(r.budgetTokens);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function historyRefsFromMergeContext(ctx: MergeContext | null | undefined): HistoryRefs {
  if (!ctx) return {};
  const refs: HistoryRefs = { operation: ctx.operation };
  if (ctx.oursSha) refs.oursSha = ctx.oursSha;
  if (ctx.theirsSha) refs.theirsSha = ctx.theirsSha;
  return refs;
}

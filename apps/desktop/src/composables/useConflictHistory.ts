/**
 * v3.11.1 — Desktop glue for the history-aware LLM prompts.
 *
 * The algorithm lives in `@gitwand/core` (`collectHunkHistory`); this file
 * only supplies git access (`gitExec`, which works under Tauri and under
 * dev-server.mjs alike, so there is no parity gap to cover) and the settings
 * precedence: `.gitwandrc` `history.enabled: false` wins, otherwise the app
 * settings apply.
 */

import {
  clampHistoryBudget,
  collectHunkHistory,
  createHistoryCache,
  historyLabels,
  renderHistorySection,
  type GitRunner,
  type HistoryConfig,
  type HistoryRefs,
  type MergeContext,
} from "@gitwand/core";
import { gitExec, gitRepoState, readGitwandrc } from "../utils/backend";
import { parseLlmFallbackFromRc } from "../utils/llmFallbackRc";
import { loadSettings } from "./useSettings";

export function makeGitRunner(cwd: string): GitRunner {
  return async (args) => {
    const r = await gitExec(cwd, args);
    return { stdout: r.stdout, exitCode: r.exitCode };
  };
}

export async function readHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const r = await gitExec(cwd, ["rev-parse", "HEAD"]);
    const sha = r.stdout.trim();
    return r.exitCode === 0 && sha ? sha : undefined;
  } catch {
    return undefined;
  }
}

const OPERATION: Record<string, MergeContext["operation"]> = {
  merge: "merge", rebase: "rebase", rebase_interactive: "rebase", cherry_pick: "cherry-pick", revert: "revert",
};

export async function detectHistoryRefs(cwd: string): Promise<HistoryRefs> {
  try {
    const st = await gitRepoState(cwd);
    const operation = OPERATION[st.state];
    if (!operation) return {};
    const refs: HistoryRefs = { operation };
    const oursSha = await readHeadSha(cwd);
    if (oursSha) refs.oursSha = oursSha;
    if (st.operationHead) refs.theirsSha = st.operationHead;
    return refs;
  } catch {
    return {};
  }
}

export function effectiveHistoryConfig(
  app: { aiHistoryEnabled: boolean; aiHistoryBudgetTokens: number },
  rc?: Partial<HistoryConfig>,
): HistoryConfig {
  return {
    enabled: rc?.enabled === false ? false : app.aiHistoryEnabled,
    budgetTokens: clampHistoryBudget(rc?.budgetTokens ?? app.aiHistoryBudgetTokens),
  };
}

type HunkLike = { oursLines: string[]; theirsLines: string[]; startLine: number };

/**
 * One renderer per conflict snapshot: it resolves the refs and the config
 * once, and shares the per-file git cache across every hunk it renders.
 * Resolves `undefined` when history is off or anything fails, so the caller
 * simply sends the prompt without it.
 */
export function createHunkHistoryRenderer(cwd: string) {
  const runGit = makeGitRunner(cwd);
  const cache = createHistoryCache();
  let setup: Promise<{ refs: HistoryRefs; cfg: HistoryConfig }> | null = null;

  async function load() {
    const [refs, rcRaw] = await Promise.all([detectHistoryRefs(cwd), readGitwandrc(cwd).catch(() => "")]);
    const rc = parseLlmFallbackFromRc(rcRaw)?.history;
    return { refs, cfg: effectiveHistoryConfig(loadSettings(), rc) };
  }

  return async (filePath: string, hunk: HunkLike): Promise<string | undefined> => {
    try {
      const { refs, cfg } = await (setup ??= load());
      if (!cfg.enabled) return undefined;
      const history = await collectHunkHistory(runGit, { filePath, hunk, refs, cache });
      return renderHistorySection(history, cfg.budgetTokens, historyLabels(refs.operation)).text;
    } catch {
      return undefined;
    }
  };
}

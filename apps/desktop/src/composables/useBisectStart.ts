/**
 * Starting a guided bisect from the Git Tree (design:
 * docs/superpowers/specs/2026-11-26-guided-bisect-design.md): the context
 * menu asks, a confirmation names both ends, then `gitBisectStart` runs.
 */
import { computed, ref } from "vue";
import { DETACHED_BRANCH_NAMES } from "./useAutoFastForward";
import type { GitLogEntry } from "../utils/backend";
import { inLoadedHistoryOf } from "../utils/bisectEndpoints";
import { t } from "./useI18n";
import { bisectErrorMessage } from "./bisectError";

/** HEAD's row in the loaded Git Tree log (its `%D` decoration names HEAD). */
export function headEntry(log: readonly GitLogEntry[]): GitLogEntry | undefined {
  return log.find((e) => /(^|, )HEAD( ->|,|$)/.test(e.refs));
}

async function bisectIsActive(cwd: string): Promise<boolean> {
  try {
    const { gitBisectStatus } = await import("../utils/backend");
    return (await gitBisectStatus(cwd)).active;
  } catch {
    // The status cannot be read: the repo state will tell.
    const { gitRepoState } = await import("../utils/backend");
    return (await gitRepoState(cwd).catch(() => null))?.state === "bisect";
  }
}

export function useBisectStart(opts: {
  cwd: () => string;
  /** The current branch (`git status`), or a detached placeholder. */
  branch: () => string;
  /** The loaded Git Tree log. */
  log: () => readonly GitLogEntry[];
  /** Tells the user why a bisect cannot start. */
  notify: (title: string, detail: string | null) => void;
  /** The bisect started: reload repo state, status and the log. */
  onStarted: () => Promise<void>;
}) {
  /**
   * A bisect waiting for the user's confirmation. `ordered`: the loaded log
   * shows `good` is an ancestor of `bad`; otherwise the confirmation does not
   * say which end is which (the backend orders them by ancestry).
   */
  const confirm = ref<{ good: string; bad: string; ordered: boolean; keepOrder?: boolean } | null>(null);
  const starting = ref(false);

  /** Two ends in any order (the Git Tree's row order is not ancestry). */
  function ask(a: string, b: string) {
    const log = opts.log();
    const aFirst = inLoadedHistoryOf(log, a, b);
    if (aFirst === true) {
      confirm.value = { good: a, bad: b, ordered: true };
      return;
    }
    const bFirst = inLoadedHistoryOf(log, b, a);
    if (bFirst === true) {
      confirm.value = { good: b, bad: a, ordered: true };
      return;
    }
    if (aFirst === false && bFirst === false) {
      opts.notify(t("bisect.startFailed"), t("bisect.errors.unrelated"));
      return;
    }
    confirm.value = { good: a, bad: b, ordered: false };
  }

  /** "Bisect from here": this commit is good, HEAD (found in the loaded log) is bad. */
  function askFromHere(entry: GitLogEntry) {
    const log = opts.log();
    const head = headEntry(log);
    if (!head) {
      opts.notify(t("bisect.noHead"), null);
      return;
    }
    // Explained before the confirmation, not after it, when the loaded log
    // can tell. Otherwise the backend refuses with the same reason: the ends
    // are kept as the menu names them (`keepOrder`), never swapped.
    if (inLoadedHistoryOf(log, entry.hashFull, head.hashFull) === false) {
      opts.notify(t("bisect.notInHead"), null);
      return;
    }
    confirm.value = { good: entry.hashFull, bad: head.hashFull, ordered: true, keepOrder: true };
  }

  function cancel() {
    confirm.value = null;
  }

  async function start() {
    const pair = confirm.value;
    const cwd = opts.cwd();
    if (!pair || !cwd || starting.value) return;
    starting.value = true;
    try {
      const { gitBisectStart } = await import("../utils/backend");
      await gitBisectStart(cwd, pair.bad, pair.good, pair.keepOrder === true);
      confirm.value = null;
      await opts.onStarted();
    } catch (e) {
      // git may have started it and only the status read after it failed:
      // then the banner takes over (with that error), not a start failure.
      // Not for GitWand's own refusals (`bisect:<code>:`): a `bisect:busy`
      // means another bisect (a terminal's) is running, not this one.
      const refused = /^bisect:\w+:/.test(e instanceof Error ? e.message : String(e));
      if (!refused && (await bisectIsActive(cwd))) {
        confirm.value = null;
        await opts.onStarted();
      } else {
        opts.notify(t("bisect.startFailed"), bisectErrorMessage(e));
      }
    } finally {
      starting.value = false;
    }
  }

  /**
   * Where End bisect returns to (what `BISECT_START` will record): the
   * branch, or HEAD's short hash when it is detached.
   */
  const returnsTo = computed(() => {
    const branch = opts.branch();
    if (branch && !DETACHED_BRANCH_NAMES.has(branch)) return branch;
    return headEntry(opts.log())?.hashFull.slice(0, 7) ?? "HEAD";
  });

  return { confirm, starting, ask, askFromHere, cancel, start, returnsTo };
}

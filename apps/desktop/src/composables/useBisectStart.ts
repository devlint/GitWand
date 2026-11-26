/**
 * Starting a guided bisect from the Git Tree (design:
 * docs/superpowers/specs/2026-11-26-guided-bisect-design.md): the context
 * menu asks, a confirmation names both ends, then `gitBisectStart` runs.
 */
import { ref } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { inLoadedHistoryOf } from "../utils/bisectEndpoints";
import { t } from "./useI18n";
import { bisectErrorMessage } from "./bisectError";

export function useBisectStart(opts: {
  cwd: () => string;
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
    const head = log.find((e) => /(^|, )HEAD( ->|,|$)/.test(e.refs));
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
      opts.notify(t("bisect.startFailed"), bisectErrorMessage(e));
    } finally {
      starting.value = false;
    }
  }

  return { confirm, starting, ask, askFromHere, cancel, start };
}

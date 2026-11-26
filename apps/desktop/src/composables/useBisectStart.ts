/**
 * Starting a guided bisect from the Git Tree (design:
 * docs/superpowers/specs/2026-11-26-guided-bisect-design.md): the context
 * menu asks, a confirmation names both ends, then `gitBisectStart` runs.
 */
import { ref } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { inLoadedHistoryOf } from "../utils/bisectEndpoints";
import { t } from "./useI18n";

export function useBisectStart(opts: {
  cwd: () => string;
  /** The loaded Git Tree log. */
  log: () => readonly GitLogEntry[];
  /** Tells the user why a bisect cannot start. */
  notify: (title: string, detail: string | null) => void;
  /** The bisect started: reload repo state, status and the log. */
  onStarted: () => Promise<void>;
}) {
  /** A bisect waiting for the user's confirmation. */
  const confirm = ref<{ good: string; bad: string } | null>(null);
  const starting = ref(false);

  function ask(good: string, bad: string) {
    confirm.value = { good, bad };
  }

  /** "Bisect from here": this commit is good, HEAD (found in the loaded log) is bad. */
  function askFromHere(entry: GitLogEntry) {
    const log = opts.log();
    const head = log.find((e) => /(^|, )HEAD( ->|,|$)/.test(e.refs));
    if (!head) {
      opts.notify(t("bisect.noHead"), null);
      return;
    }
    // Explained before the confirmation, not after it (when the loaded log
    // can tell; otherwise the backend refuses with the same reason).
    if (inLoadedHistoryOf(log, entry.hashFull, head.hashFull) === false) {
      opts.notify(t("bisect.notInHead"), null);
      return;
    }
    ask(entry.hashFull, head.hashFull);
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
      await gitBisectStart(cwd, pair.bad, pair.good);
      confirm.value = null;
      await opts.onStarted();
    } catch (e) {
      opts.notify(t("bisect.startFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      starting.value = false;
    }
  }

  return { confirm, starting, ask, askFromHere, cancel, start };
}

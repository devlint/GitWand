import { ref, type Ref } from "vue";
import type { FileLogEntry, PickaxeMode } from "../utils/backend";

export interface FileHistoryLoaders {
  getPickaxe: (cwd: string, path: string, search: string, mode: PickaxeMode) => Promise<FileLogEntry[]>;
  getRange: (cwd: string, path: string, startLine: number, endLine: number) => Promise<FileLogEntry[]>;
}

/**
 * The file history viewer's per-file lists — the `--follow` log, pickaxe and
 * line-range results — and the generation token that keeps them per-file.
 *
 * `startFile()` begins a new file: it bumps the token and clears every list,
 * error and loading flag. Every loader, here and in the component (blame, the
 * log itself), captures the token before awaiting and writes nothing once it
 * is stale, so a reply for the previous file can never land in the new one's
 * state — or become the name source of its compare.
 */
export function useFileHistoryLists(opts: {
  cwd: Readonly<Ref<string>>;
  filePath: Readonly<Ref<string>>;
  loaders: FileHistoryLoaders;
}) {
  let generation = 0;

  const fileLog = ref<FileLogEntry[]>([]);

  const pickaxeResults = ref<FileLogEntry[] | null>(null);
  const pickaxeLoading = ref(false);
  const pickaxeError = ref<string | null>(null);

  const rangeLogLines = ref<{ start: number; end: number } | null>(null);
  const rangeLogResults = ref<FileLogEntry[] | null>(null);
  const rangeLogLoading = ref(false);
  const rangeLogError = ref<string | null>(null);

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  function clearPickaxe() {
    pickaxeResults.value = null;
    pickaxeError.value = null;
    pickaxeLoading.value = false;
  }

  function clearRangeLog() {
    rangeLogLines.value = null;
    rangeLogResults.value = null;
    rangeLogError.value = null;
    rangeLogLoading.value = false;
  }

  /** A new file: stale every reply in flight, start from empty lists. */
  function startFile(): number {
    generation++;
    fileLog.value = [];
    clearPickaxe();
    clearRangeLog();
    return generation;
  }

  const token = () => generation;
  const isCurrent = (t: number) => t === generation;

  async function runPickaxe(search: string, mode: PickaxeMode) {
    const q = search.trim();
    if (!q || !opts.cwd.value || !opts.filePath.value) return;
    const t = generation;
    pickaxeLoading.value = true;
    pickaxeError.value = null;
    try {
      const results = await opts.loaders.getPickaxe(opts.cwd.value, opts.filePath.value, q, mode);
      if (isCurrent(t)) pickaxeResults.value = results;
    } catch (err) {
      if (isCurrent(t)) pickaxeError.value = message(err);
    } finally {
      if (isCurrent(t)) pickaxeLoading.value = false;
    }
  }

  async function showRangeHistory(startLine: number, endLine: number) {
    if (!opts.cwd.value || !opts.filePath.value) return;
    const t = generation;
    rangeLogLines.value = { start: startLine, end: endLine };
    rangeLogResults.value = null;
    rangeLogError.value = null;
    rangeLogLoading.value = true;
    try {
      const results = await opts.loaders.getRange(opts.cwd.value, opts.filePath.value, startLine, endLine);
      if (isCurrent(t)) rangeLogResults.value = results;
    } catch (err) {
      if (isCurrent(t)) rangeLogError.value = message(err);
    } finally {
      if (isCurrent(t)) rangeLogLoading.value = false;
    }
  }

  return {
    fileLog,
    pickaxeResults,
    pickaxeLoading,
    pickaxeError,
    rangeLogLines,
    rangeLogResults,
    rangeLogLoading,
    rangeLogError,
    startFile,
    token,
    isCurrent,
    runPickaxe,
    clearPickaxe,
    showRangeHistory,
    clearRangeLog,
  };
}

import type { BlameLine } from "../utils/backend";

/**
 * useBlameGutter — pure, view-agnostic helpers that turn a `BlameLine[]`
 * (from `getGitBlame`) into a per-line model the CodeMirror blame gutter in
 * FileExplorerPanel.vue renders. Kept free of any @codemirror/* import so the
 * transform logic is unit-testable in jsdom without loading the editor.
 *
 * The CodeMirror wiring (GutterMarker / gutter extension) lives in the
 * component; this module owns only the data shaping and formatting.
 */

/** One source line's blame annotation, ready to render in the gutter. */
export interface BlameGutterEntry {
  /** Abbreviated commit hash (git blame's short form). */
  hashShort: string;
  /** Full 40-char hash — used for tooltips / future jump-to-commit. */
  hashFull: string;
  /** Compact gutter label: `author · YYYY-MM-DD`. */
  label: string;
  /**
   * True only on the first line of a run of consecutive lines sharing the same
   * commit — so the gutter shows the author once per block, like every blame
   * UI, instead of repeating it on every line.
   */
  showLabel: boolean;
  /** Rich hover tooltip: hash, author, full date and the commit summary. */
  title: string;
}

/**
 * Format git blame's `author-time` (Unix epoch **seconds**, as a string) into
 * a short `YYYY-MM-DD`. Returns "" for missing/unparseable input so the gutter
 * degrades gracefully rather than rendering "NaN".
 */
export function formatBlameDate(epochSeconds: string): string {
  const secs = Number(epochSeconds);
  if (!epochSeconds || !Number.isFinite(secs) || secs <= 0) return "";
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Build a `finalLine (1-based) → BlameGutterEntry` map from raw blame lines.
 * Consecutive lines belonging to the same commit collapse to a single visible
 * label (`showLabel` false on the continuation lines).
 */
export function buildBlameModel(lines: BlameLine[]): Map<number, BlameGutterEntry> {
  const model = new Map<number, BlameGutterEntry>();
  let prevHash: string | null = null;
  for (const line of lines) {
    const date = formatBlameDate(line.authorDate);
    const author = line.author || "Unknown";
    const label = date ? `${author} · ${date}` : author;
    const summary = line.summary ? `\n${line.summary}` : "";
    model.set(line.finalLine, {
      hashShort: line.hash,
      hashFull: line.hashFull,
      label,
      showLabel: line.hashFull !== prevHash,
      title: `${line.hash} · ${author}${date ? ` · ${date}` : ""}${summary}`,
    });
    prevHash = line.hashFull;
  }
  return model;
}

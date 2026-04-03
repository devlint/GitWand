/**
 * Word-level diff highlighting.
 *
 * Compares two arrays of lines and produces HTML with
 * <span class="diff-add"> / <span class="diff-del"> markers
 * around the tokens that differ.
 */

/** Tokenize a line into words + whitespace, preserving everything. */
function tokenize(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? [line];
}

/** Classic LCS on token arrays — returns the common subsequence indices. */
function lcsTokens(a: string[], b: string[]): { aIdx: Set<number>; bIdx: Set<number> } {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find which indices are part of LCS
  const aIdx = new Set<number>();
  const bIdx = new Set<number>();
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      aIdx.add(i - 1);
      bIdx.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return { aIdx, bIdx };
}

/** Escape HTML special chars. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Given two lines, return HTML for `source` where differing tokens
 * are wrapped in a highlight span.
 *
 * @param source - The line to render (e.g. "ours" line)
 * @param reference - The line to compare against (e.g. "base" line)
 * @param cssClass - The CSS class for highlighted tokens ("diff-add" or "diff-del")
 *
 * If reference is null, the entire line is highlighted.
 */
function highlightLine(
  source: string,
  reference: string | null,
  cssClass: string,
): string {
  if (reference === null) {
    return `<span class="${cssClass}">${esc(source)}</span>`;
  }

  if (source === reference) {
    return esc(source);
  }

  const srcTokens = tokenize(source);
  const refTokens = tokenize(reference);
  const { aIdx } = lcsTokens(srcTokens, refTokens);

  let html = "";
  let inHighlight = false;

  for (let i = 0; i < srcTokens.length; i++) {
    const isCommon = aIdx.has(i);

    if (!isCommon && !inHighlight) {
      html += `<span class="${cssClass}">`;
      inHighlight = true;
    } else if (isCommon && inHighlight) {
      html += "</span>";
      inHighlight = false;
    }

    html += esc(srcTokens[i]);
  }

  if (inHighlight) {
    html += "</span>";
  }

  return html;
}

export interface HighlightedPanel {
  /** Array of HTML strings, one per line */
  lines: string[];
}

/**
 * Produce highlighted HTML for a 3-way conflict.
 *
 * Strategy:
 * - If base exists: highlight ours vs base and theirs vs base
 *   (shows what each branch changed)
 * - If no base (diff2): highlight ours vs theirs and theirs vs ours
 *   (shows the differences between the two sides)
 */
export function highlightConflict(
  oursLines: string[],
  baseLines: string[],
  theirsLines: string[],
): { ours: HighlightedPanel; base: HighlightedPanel; theirs: HighlightedPanel } {
  const hasBase = baseLines.length > 0;

  // For line-by-line comparison we align by index.
  // Lines beyond the shorter array get null as reference.
  const maxLen = Math.max(oursLines.length, baseLines.length, theirsLines.length);

  const oursHtml: string[] = [];
  const baseHtml: string[] = [];
  const theirsHtml: string[] = [];

  for (let i = 0; i < oursLines.length; i++) {
    const ref = hasBase
      ? (i < baseLines.length ? baseLines[i] : null)
      : (i < theirsLines.length ? theirsLines[i] : null);
    oursHtml.push(highlightLine(oursLines[i], ref, "diff-add"));
  }

  for (let i = 0; i < baseLines.length; i++) {
    // Base is the reference — render it plain
    baseHtml.push(esc(baseLines[i]));
  }

  for (let i = 0; i < theirsLines.length; i++) {
    const ref = hasBase
      ? (i < baseLines.length ? baseLines[i] : null)
      : (i < oursLines.length ? oursLines[i] : null);
    theirsHtml.push(highlightLine(theirsLines[i], ref, "diff-add"));
  }

  return {
    ours: { lines: oursHtml },
    base: { lines: baseHtml },
    theirs: { lines: theirsHtml },
  };
}

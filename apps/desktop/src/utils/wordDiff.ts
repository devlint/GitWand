/**
 * Word-level diff utility.
 *
 * Given two strings (old line and new line), produces an array of segments
 * marking which characters are common, deleted, or inserted.
 * Uses a simple LCS-based approach on word tokens for performance.
 */

export interface DiffSegment {
  type: "equal" | "delete" | "insert";
  text: string;
}

/** Tokenise a line into words and whitespace chunks. */
function tokenise(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? [line];
}

/**
 * Compute LCS table for two token arrays.
 * Returns the length table (for backtracking).
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

/**
 * Compute word-level diff segments between two lines.
 * Returns segments for the "old" side and the "new" side separately.
 */
export function wordDiff(
  oldLine: string,
  newLine: string,
): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const oldTokens = tokenise(oldLine);
  const newTokens = tokenise(newLine);

  // Short-circuit: identical lines
  if (oldLine === newLine) {
    return {
      oldSegments: [{ type: "equal", text: oldLine }],
      newSegments: [{ type: "equal", text: newLine }],
    };
  }

  // Short-circuit: completely different (one side empty)
  if (oldTokens.length === 0) {
    return {
      oldSegments: [],
      newSegments: [{ type: "insert", text: newLine }],
    };
  }
  if (newTokens.length === 0) {
    return {
      oldSegments: [{ type: "delete", text: oldLine }],
      newSegments: [],
    };
  }

  const dp = lcsTable(oldTokens, newTokens);

  // Backtrack to produce the diff
  const oldSegs: DiffSegment[] = [];
  const newSegs: DiffSegment[] = [];
  let i = oldTokens.length;
  let j = newTokens.length;

  // Collect in reverse, then reverse at the end
  const ops: Array<{ type: "equal" | "delete" | "insert"; old?: string; new?: string }> = [];

  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      ops.push({ type: "equal", old: oldTokens[i - 1], new: newTokens[j - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "delete", old: oldTokens[i - 1] });
      i--;
    } else {
      ops.push({ type: "insert", new: newTokens[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ type: "delete", old: oldTokens[i - 1] });
    i--;
  }
  while (j > 0) {
    ops.push({ type: "insert", new: newTokens[j - 1] });
    j--;
  }

  ops.reverse();

  // Build segments for old and new sides, merging consecutive same-type segments
  for (const op of ops) {
    if (op.type === "equal") {
      pushSegment(oldSegs, "equal", op.old!);
      pushSegment(newSegs, "equal", op.new!);
    } else if (op.type === "delete") {
      pushSegment(oldSegs, "delete", op.old!);
    } else {
      pushSegment(newSegs, "insert", op.new!);
    }
  }

  return { oldSegments: oldSegs, newSegments: newSegs };
}

function pushSegment(segs: DiffSegment[], type: DiffSegment["type"], text: string) {
  const last = segs[segs.length - 1];
  if (last && last.type === type) {
    last.text += text;
  } else {
    segs.push({ type, text });
  }
}

/**
 * Render diff segments to HTML with highlighting spans.
 * - `delete` segments get <span class="wd-del">
 * - `insert` segments get <span class="wd-ins">
 * - `equal` segments are HTML-escaped as-is
 */
export function segmentsToHtml(segments: DiffSegment[]): string {
  return segments
    .map((seg) => {
      const escaped = escapeHtml(seg.text);
      if (seg.type === "delete") return `<span class="wd-del">${escaped}</span>`;
      if (seg.type === "insert") return `<span class="wd-ins">${escaped}</span>`;
      return escaped;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

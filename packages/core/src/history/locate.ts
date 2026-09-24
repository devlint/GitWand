/**
 * v3.11.1 — Find where a hunk side's lines sit in that side's full file
 * (`git show :2:path` / `:3:path`). Line numbers in the conflicted file do
 * not match either side, because auto-merged regions shift them; searching
 * for the exact block does. `nearLine` only breaks ties between duplicates.
 */
export function locateBlock(
  fileLines: string[],
  block: string[],
  nearLine: number,
): { start: number; end: number } | null {
  if (block.length === 0 || block.length > fileLines.length) return null;
  let best: number | null = null;
  for (let i = 0; i + block.length <= fileLines.length; i++) {
    let match = true;
    for (let j = 0; j < block.length; j++) {
      if (fileLines[i + j] !== block[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const start = i + 1;
    if (best === null || Math.abs(start - nearLine) < Math.abs(best - nearLine)) best = start;
  }
  return best === null ? null : { start: best, end: best + block.length - 1 };
}

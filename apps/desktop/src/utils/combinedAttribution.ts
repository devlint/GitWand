/**
 * Per-line commit attribution for a combined diff (spec §5.4).
 *
 * Works on the already-parsed `-U0` replay step diffs (`CombinedDiff.steps`);
 * no diff parsing here. For each path we keep a segment model of the file as
 * it evolves through the replay: runs of untouched base lines and runs of
 * lines introduced by a given commit. Hunks of a step are applied last to
 * first so old-side coordinates stay valid.
 */
import type { CombinedDiff, DiffHunk, GitDiff } from "./backend";
import { lineKeyFor } from "./diffLineKey";

export interface FileAttribution {
  /** lineKey → commit index (replay order). */
  lineCommit: Map<string, number>;
  /** Per hunk: sorted unique commit indexes. */
  hunkCommits: number[][];
  /** Set on fallback sections: the whole section is this commit. */
  sectionCommit?: number;
}

export interface CombinedEntry {
  diff: GitDiff;
  attribution: FileAttribution;
  fallback?: { blockers: string[]; conflicted: boolean };
}

type Seg = { kind: "base"; start: number; len: number } | { kind: "commit"; idx: number; len: number };

interface Model {
  segs: Seg[];
  /** base line number → index of the commit that deleted it */
  deletedBy: Map<number, number>;
  /** Base path whose lines the `base` segments and `deletedBy` count; null for a file absent from the base. */
  baseOrigin: string | null;
  /**
   * Set once two different base lineages met on this path (e.g. a rename
   * onto a path that still had its own model): no line of it can be
   * attributed with certainty, so it gets none.
   */
  unattributable: boolean;
}

function freshModel(baseOrigin: string | null): Model {
  return {
    segs: baseOrigin === null ? [] : [{ kind: "base", start: 1, len: Infinity }],
    deletedBy: new Map(),
    baseOrigin,
    unattributable: false,
  };
}

/** Make sure a segment boundary exists at 0-based `pos`; return the index of the segment starting there. */
function splitAt(segs: Seg[], pos: number): number {
  let off = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (off === pos) return i;
    if (pos < off + s.len) {
      const k = pos - off;
      const left: Seg = s.kind === "base" ? { kind: "base", start: s.start, len: k } : { kind: "commit", idx: s.idx, len: k };
      const right: Seg =
        s.kind === "base"
          ? { kind: "base", start: s.start + k, len: s.len - k }
          : { kind: "commit", idx: s.idx, len: s.len - k };
      segs.splice(i, 1, left, right);
      return i + 1;
    }
    off += s.len;
  }
  return segs.length;
}

function applyHunk(model: Model, h: DiffHunk, step: number): void {
  const pos = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
  if (pos < 0) return;
  const from = splitAt(model.segs, pos);
  const to = h.oldCount > 0 ? splitAt(model.segs, pos + h.oldCount) : from;
  const removed = model.segs.splice(from, to - from);
  for (const s of removed) {
    if (s.kind === "base" && Number.isFinite(s.len)) {
      for (let k = 0; k < s.len; k++) model.deletedBy.set(s.start + k, step);
    }
  }
  if (h.newCount > 0) model.segs.splice(from, 0, { kind: "commit", idx: step, len: h.newCount });
}

/** Commit index owning 0-based position `pos`, or undefined for a base line / out of range. */
function originAt(segs: Seg[], pos: number): number | undefined {
  let off = 0;
  for (const s of segs) {
    if (pos < off + s.len) return s.kind === "commit" ? s.idx : undefined;
    off += s.len;
  }
  return undefined;
}

function replay(c: CombinedDiff): Map<string, Model> {
  const models = new Map<string, Model>();
  c.steps.forEach((files, i) => {
    for (const f of files) {
      if (f.status === "renamed" && f.oldPath) {
        const moved = models.get(f.oldPath) ?? freshModel(f.oldPath);
        models.delete(f.oldPath);
        const target = models.get(f.path);
        // The target still has a model of another base file (deleted earlier
        // in the range, say): its net `-` lines count that file's base lines,
        // the moved model counts the source's. Never guess between the two.
        if (target && target !== moved && target.baseOrigin !== null && target.baseOrigin !== moved.baseOrigin) {
          moved.unattributable = true;
        }
        models.set(f.path, moved);
      } else if (f.status === "added") {
        // Re-added after an earlier step deleted it: the new content starts
        // empty, but the base lines it lost keep their deleter.
        const prev = models.get(f.path);
        if (prev) prev.segs = [];
        else models.set(f.path, freshModel(null));
      } else if (!models.has(f.path)) {
        models.set(f.path, freshModel(f.path));
      }
      const model = models.get(f.path)!;
      for (let k = f.hunks.length - 1; k >= 0; k--) applyHunk(model, f.hunks[k], i);
    }
  });
  return models;
}

function attributeNet(diff: GitDiff, model: Model | undefined): FileAttribution {
  const lineCommit = new Map<string, number>();
  const hunkCommits: number[][] = [];
  if (model?.unattributable) return { lineCommit, hunkCommits: diff.hunks.map(() => []) };
  for (const h of diff.hunks) {
    const set = new Set<number>();
    for (const l of h.lines) {
      let idx: number | undefined;
      if (l.type === "add" && l.newLineNo != null && model) idx = originAt(model.segs, l.newLineNo - 1);
      else if (l.type === "delete" && l.oldLineNo != null && model) idx = model.deletedBy.get(l.oldLineNo);
      if (idx === undefined) continue;
      const key = lineKeyFor(l);
      if (key === null) continue;
      lineCommit.set(key, idx);
      set.add(idx);
    }
    hunkCommits.push([...set].sort((a, b) => a - b));
  }
  return { lineCommit, hunkCommits };
}

export function buildCombinedEntries(c: CombinedDiff): CombinedEntry[] {
  const models = replay(c);
  const entries: CombinedEntry[] = c.diffs.map((diff) => ({
    diff,
    attribution: attributeNet(diff, models.get(diff.path)),
  }));

  for (const fb of c.fallback) {
    for (const p of fb.perCommit) {
      const idx = c.commits.findIndex((cm) => cm.hash === p.hash);
      const lineCommit = new Map<string, number>();
      const hunkCommits: number[][] = [];
      for (const h of p.diff.hunks) {
        if (idx >= 0) {
          // Only the lines the commit wrote: context lines are not its own,
          // and the section chip already names the commit.
          for (const l of h.lines) {
            if (l.type !== "add" && l.type !== "delete") continue;
            const key = lineKeyFor(l);
            if (key !== null) lineCommit.set(key, idx);
          }
        }
        hunkCommits.push(idx >= 0 ? [idx] : []);
      }
      entries.push({
        diff: p.diff,
        attribution: { lineCommit, hunkCommits, ...(idx >= 0 ? { sectionCommit: idx } : {}) },
        fallback: { blockers: fb.blockers, conflicted: fb.conflicted },
      });
    }
  }
  return entries;
}

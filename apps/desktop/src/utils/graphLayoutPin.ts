/**
 * Layout-cache helpers for the Git Tree (CommitGraph.vue).
 *
 * The graph caches its DAG layout behind a cheap fingerprint and pins the
 * trunk (main/master) to lane 0. Both used to look only at commit hashes, so a
 * ref moving without the top commit changing (reset main onto origin/main, a
 * new branch on an existing commit, checking out a previous branch) left stale
 * lanes and a stale trunk until a restart (#266). These helpers fold the
 * decorations into both decisions while staying O(n) — one pass over the rows.
 */
import { parseRefs } from "./dagLayout";

export interface GraphRow {
  hashFull: string;
  parents: string[];
  refs: string;
}

export interface RefsSignature {
  /** Decorations of every row. */
  full: string;
  /** Decorations of the first `prefixLen` rows (the rows the pin was set on). */
  prefix: string;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Fold a string into a running 32-bit FNV-1a hash. */
function fnv1a(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h;
}

/**
 * Signature of the rows' decorations, built in one pass: a 32-bit FNV-1a hash
 * over each decorated row's hash and `%D` string, plus the decorated-row
 * count. Only decorated rows contribute (most rows carry no ref), and the
 * result stays a few bytes however many tags the repo has.
 */
export function refsSignature(rows: readonly GraphRow[], prefixLen: number): RefsSignature {
  let h = FNV_OFFSET;
  let count = 0;
  let prefix = "";
  const n = rows.length;
  const cut = Math.min(prefixLen, n);
  for (let i = 0; i < n; i++) {
    if (i === cut) prefix = count + ":" + (h >>> 0);
    const refs = rows[i].refs;
    if (refs) {
      h = fnv1a(fnv1a(fnv1a(h, rows[i].hashFull), "\x1f"), refs);
      h = fnv1a(h, "\x1e");
      count++;
    }
  }
  const full = count + ":" + (h >>> 0);
  if (cut === n) prefix = full;
  return { full, prefix };
}

/** Layout fingerprint: bounds, current branch, WIP state and decorations. */
export function layoutFingerprint(
  rows: readonly GraphRow[],
  currentBranch: string,
  hasChanges: boolean,
  wipParent: string,
  refsSig: string,
): string {
  const n = rows.length;
  return (
    n + ":" + (rows[0]?.hashFull ?? "") + ":" + (rows[n - 1]?.hashFull ?? "") + ":" +
    currentBranch + ":" + hasChanges + ":" + wipParent + ":" + refsSig
  );
}

export const TRUNK_NAMES: ReadonlySet<string> = new Set(["main", "master"]);

/** First row carrying main/master (local or remote): the lineage pinned to lane 0. */
export function findTrunkHash(rows: readonly GraphRow[]): string | undefined {
  for (const row of rows) {
    if (!row.refs) continue;
    // Include "ambiguous" so `origin/main` (a slash-containing name
    // parseRefs() can't classify on its own, see #137) still matches here
    // — the remote prefix is stripped before the name check.
    if (parseRefs(row.refs).some((r) =>
      (r.type === "branch" || r.type === "remote" || r.type === "ambiguous") &&
      TRUNK_NAMES.has(r.name.includes("/") ? r.name.split("/").pop()! : r.name)
    )) {
      return row.hashFull;
    }
  }
  return undefined;
}

export interface TrunkPin {
  /** Real HEAD hash (top row, or the WIP node's parent) the pin was set under. */
  headHash: string;
  trunkHash: string | undefined;
  /** `refsSignature(...).full` of the rows the pin covers. */
  refsSig: string;
  /** Row count the pin covers. */
  rowCount: number;
}

export const EMPTY_PIN: TrunkPin = {
  headHash: "",
  trunkHash: undefined,
  refsSig: "",
  rowCount: 0,
};

/**
 * The pin for this layout pass. An infinite-scroll append (same head, rows
 * only added, decorations of the already-pinned rows unchanged) keeps the
 * previous trunk so existing rows never jump lanes. Anything else — the top
 * commit moved, rows went away, or a ref moved among the pinned rows —
 * re-detects the trunk.
 *
 * @param sig `refsSignature(rows, prev.rowCount)`.
 */
export function nextTrunkPin(
  prev: TrunkPin,
  rows: readonly GraphRow[],
  headHash: string,
  sig: RefsSignature,
): TrunkPin {
  const appendOnly =
    headHash === prev.headHash &&
    rows.length >= prev.rowCount &&
    sig.prefix === prev.refsSig;
  if (appendOnly) {
    return { ...prev, refsSig: sig.full, rowCount: rows.length };
  }
  return {
    headHash,
    trunkHash: findTrunkHash(rows),
    refsSig: sig.full,
    rowCount: rows.length,
  };
}

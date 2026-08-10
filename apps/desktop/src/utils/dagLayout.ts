/**
 * dagLayout.ts — Simple DAG lane assignment for a git commit graph.
 *
 * Takes a list of commits (with parent hashes) and computes:
 * - Which lane (column) each commit is drawn in
 * - Which edges connect commits to their parents
 *
 * The algorithm assigns lanes left-to-right, reusing freed lanes
 * when branches merge back. This produces a compact graph.
 *
 * Lane priority:
 *   0          — main / master (trunk)
 *   next slots — all other branches, allocated on demand (greedy)
 */

export interface DagNode {
  /** Index in the original commit list */
  index: number;
  /** Full commit hash */
  hash: string;
  /** Parent hashes */
  parents: string[];
  /** Assigned lane (0-based column) */
  lane: number;
}

export interface DagEdge {
  /** Source commit index (child) */
  fromIndex: number;
  fromLane: number;
  /** Target commit index (parent) */
  toIndex: number;
  toLane: number;
  /** Is this a merge edge (second+ parent)? */
  isMerge: boolean;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Maximum lane used (for sizing) */
  maxLane: number;
}

/**
 * Compute DAG layout for a list of commits.
 * Commits must be in reverse chronological order (newest first).
 *
 * @param trunkHash     Head of main/master — pinned to lane 0.
 * @param secondaryHashes Heads of other branches to pin to lanes 1, 2, …
 *                        in the order supplied. Commits on their first-parent
 *                        chains are kept on those lanes throughout the graph.
 */
export function computeDagLayout(
  commits: Array<{ hashFull: string; parents: string[] }>,
  trunkHash?: string,
  secondaryHashes?: string[],
): DagLayout {
  const nodes: DagNode[] = [];
  const edges: DagEdge[] = [];

  const hashToIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    hashToIndex.set(commits[i].hashFull, i);
  }

  // ── Build pinnedLane: hash → forced lane number ──────────────────────────
  // Lower lane numbers take priority (trunk wins over release, etc.).
  // Each priority chain is the first-parent lineage of its head commit.
  const pinnedLane = new Map<string, number>();

  function tracePinnedChain(headHash: string, lane: number): void {
    let h: string | undefined = headHash;
    while (h && hashToIndex.has(h)) {
      if (!pinnedLane.has(h)) pinnedLane.set(h, lane);
      h = commits[hashToIndex.get(h)!].parents[0];
    }
  }

  if (trunkHash && hashToIndex.has(trunkHash)) {
    tracePinnedChain(trunkHash, 0);
  }

  // Only accept secondary hashes that exist in the loaded commit list.
  const validSecondary: Array<{ hash: string; lane: number }> = [];
  let nextSecLane = 1;
  for (const sh of (secondaryHashes ?? [])) {
    if (hashToIndex.has(sh)) {
      const ln = nextSecLane++;
      validSecondary.push({ hash: sh, lane: ln });
      tracePinnedChain(sh, ln);
    }
  }

  // ── Lane allocation state ────────────────────────────────────────────────
  const hashToLane = new Map<string, number>();
  const freeLanes: number[] = [];
  // Reserve lanes 0 … (1 + validSecondary.length - 1) for pinned chains.
  // allocLane() issues numbers starting after this block.
  let lanesAllocated = trunkHash && hashToIndex.has(trunkHash)
    ? 1 + validSecondary.length
    : 0;

  // Reference-count per lane. A lane only enters the cooldown queue when its
  // count drops to 0. freeLanes may contain stale entries (re-claimed lanes) —
  // allocLane skips them via the !lanePendingCount.has() guard.
  const lanePendingCount = new Map<number, number>();
  // Edge-duration reservations: when an edge is created from child (lane X)
  // to parent P, lane X stays reserved until P is processed. This prevents
  // sibling branches from reusing the same column while a longer edge is
  // still visually traversing it.
  const parentReservations = new Map<string, number[]>();
  // Cooldown: after a lane's last edge terminates, wait this many rows before
  // allowing reuse. Prevents two unrelated branches from appearing on the same
  // column with fewer than 3 commits of visual gap between them.
  const LANE_REUSE_COOLDOWN = 3;
  const cooldownMap = new Map<number, number[]>();
  let maxLane = 0;

  function allocLane(): number {
    // Pick the lowest-numbered available free lane so the graph stays
    // compact and left-aligned (new branches fill leftward gaps first).
    let bestIdx = -1;
    let bestLane = Infinity;
    for (let j = 0; j < freeLanes.length; j++) {
      const c = freeLanes[j];
      if (!lanePendingCount.has(c) && c < bestLane) {
        bestLane = c;
        bestIdx = j;
      }
    }
    if (bestIdx !== -1) {
      freeLanes.splice(bestIdx, 1);
      return bestLane;
    }
    return lanesAllocated++;
  }

  function claimLane(hash: string, lane: number): void {
    hashToLane.set(hash, lane);
    lanePendingCount.set(lane, (lanePendingCount.get(lane) ?? 0) + 1);
    if (lane > maxLane) maxLane = lane;
  }

  function releaseRef(lane: number, row: number): void {
    const n = (lanePendingCount.get(lane) ?? 1) - 1;
    if (n <= 0) {
      lanePendingCount.delete(lane);
      // Schedule reuse after cooldown rows so visually adjacent branches
      // don't share a column with fewer than LANE_REUSE_COOLDOWN empty rows.
      const freeAtRow = row + LANE_REUSE_COOLDOWN;
      const list = cooldownMap.get(freeAtRow) ?? [];
      list.push(lane);
      cooldownMap.set(freeAtRow, list);
    } else {
      lanePendingCount.set(lane, n);
    }
  }

  function releaseClaim(hash: string, row: number): void {
    const lane = hashToLane.get(hash);
    if (lane !== undefined) {
      hashToLane.delete(hash);
      releaseRef(lane, row);
    }
  }

  function getOrClaimLane(hash: string): number {
    const existing = hashToLane.get(hash);
    if (existing !== undefined) return existing;
    const lane = allocLane();
    claimLane(hash, lane);
    return lane;
  }

  function reserveUntilParent(parentHash: string, lane: number): void {
    lanePendingCount.set(lane, (lanePendingCount.get(lane) ?? 0) + 1);
    const list = parentReservations.get(parentHash) ?? [];
    list.push(lane);
    parentReservations.set(parentHash, list);
  }

  // Move a hash that was pre-claimed to the wrong lane onto its forced lane,
  // keeping reference counts consistent.
  function relaneToForced(h: string, targetLane: number): void {
    const wrongLane = hashToLane.get(h);
    if (wrongLane === undefined || wrongLane === targetLane) return;
    const n = lanePendingCount.get(wrongLane) ?? 1;
    if (n <= 1) lanePendingCount.delete(wrongLane);
    else lanePendingCount.set(wrongLane, n - 1);
    hashToLane.set(h, targetLane);
    if (targetLane > maxLane) maxLane = targetLane;
    lanePendingCount.set(targetLane, (lanePendingCount.get(targetLane) ?? 0) + 1);
  }

  // ── Pre-seed pinned heads so their lanes are claimed from the start ───────
  if (trunkHash && hashToIndex.has(trunkHash)) {
    claimLane(trunkHash, 0);
  }
  for (const { hash: sh, lane: ln } of validSecondary) {
    if (!hashToLane.has(sh)) claimLane(sh, ln);
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const hash = commit.hashFull;

    // Drain any lanes whose cooldown expires at this row.
    const cooled = cooldownMap.get(i);
    if (cooled) {
      for (const lane of cooled) freeLanes.push(lane);
      cooldownMap.delete(i);
    }

    // Release edge-duration reservations that were waiting for this commit.
    const reserved = parentReservations.get(hash);
    if (reserved) {
      for (const lane of reserved) releaseRef(lane, i);
      parentReservations.delete(hash);
    }

    // Pinned commits (trunk or release) must land on their forced lane, even
    // if a merge-parent edge from a newer commit pre-claimed them elsewhere.
    if (pinnedLane.has(hash)) {
      const forcedLane = pinnedLane.get(hash)!;
      if (!hashToLane.has(hash)) claimLane(hash, forcedLane);
      else relaneToForced(hash, forcedLane);
    }
    const lane = getOrClaimLane(hash);
    nodes.push({ index: i, hash, parents: commit.parents, lane });
    releaseClaim(hash, i);

    for (let p = 0; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      const parentIndex = hashToIndex.get(parentHash);
      if (parentIndex === undefined) continue;

      let parentLane: number;
      // pinnedLane check MUST come before hashToLane: a pinned parent may have
      // been pre-claimed to the wrong lane as a merge-parent of an earlier
      // (newer) commit.  Force it to the correct lane and fix ref counts.
      if (pinnedLane.has(parentHash)) {
        const forcedLane = pinnedLane.get(parentHash)!;
        if (!hashToLane.has(parentHash)) claimLane(parentHash, forcedLane);
        else relaneToForced(parentHash, forcedLane);
        parentLane = forcedLane;
      } else if (hashToLane.has(parentHash)) {
        parentLane = hashToLane.get(parentHash)!;
      } else if (p === 0) {
        // First non-pinned parent inherits this lane (straight continuation).
        claimLane(parentHash, lane);
        parentLane = lane;
      } else {
        // Merge parents get a fresh lane.
        parentLane = getOrClaimLane(parentHash);
      }

      // Keep this commit's lane reserved until the parent is processed so
      // the visual column stays occupied for the full height of the edge.
      // Without this, sibling branches sharing the same parent reuse the
      // same column and appear falsely chained.
      reserveUntilParent(parentHash, lane);

      edges.push({
        fromIndex: i,
        fromLane: lane,
        toIndex: parentIndex,
        toLane: parentLane,
        isMerge: p > 0,
      });
    }
  }

  return { nodes, edges, maxLane };
}

/**
 * Parse ref decoration string into individual labels, sorted by priority
 * (branch > remote > tag > head).
 *
 * IMPORTANT (#137): a ref name containing `/` is NOT necessarily a remote
 * tracking ref of shape `<remote>/<branch>` — a local branch created with a
 * slash in its name (e.g. `test/some_experiment`) decorates identically once
 * it's no longer checked out (no `HEAD -> ` prefix). This function has no
 * way to tell the two apart from the string alone, so it deliberately does
 * NOT guess "remote" from the presence of `/`. Such refs are tagged
 * `"ambiguous"` here; CommitGraph.vue's `commitRefs()` is the sole authority
 * that resolves `"ambiguous"` into a real `"branch"` or `"remote"` using the
 * ground-truth branch list (and defaults to `"branch"` when it can't tell,
 * since an unresolved local branch is far more likely than a genuine remote
 * ref nobody could match).
 */
export function parseRefs(refs: string): Array<{ type: "head" | "branch" | "remote" | "tag" | "stash" | "ambiguous"; name: string }> {
  if (!refs) return [];
  const parsed = refs.split(",").map((r) => r.trim()).filter(Boolean).map((r) => {
    if (r === "HEAD") return { type: "head" as const, name: "HEAD" };
    if (r.startsWith("HEAD -> ")) return { type: "branch" as const, name: r.slice(8) };
    if (r.startsWith("tag: ")) return { type: "tag" as const, name: r.slice(5) };
    if (r === "refs/stash" || r === "stash") return { type: "stash" as const, name: "stash" };
    if (r.includes("/")) return { type: "ambiguous" as const, name: r };
    return { type: "branch" as const, name: r };
  });

  // Sort: Branch (local) > Ambiguous > Remote > Tag > Stash > HEAD (detached)
  const weights: Record<string, number> = {
    branch: 1,
    ambiguous: 1.5,
    remote: 2,
    tag: 3,
    stash: 4,
    head: 5,
  };

  return parsed.sort((a, b) => {
    return (weights[a.type] ?? 99) - (weights[b.type] ?? 99);
  });
}

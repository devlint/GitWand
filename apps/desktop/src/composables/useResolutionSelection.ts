/**
 * v3.11.0 — which auto-resolutions actually get applied.
 *
 * Two independent filters, combined in AND:
 *   - a global numeric confidence bar (`minScore`), and
 *   - a per-hunk opt-out the user ticks off in the merge editor.
 *
 * Design: docs/superpowers/specs/2026-09-12-v3.11.0-preview-to-apply-design.md §3.5
 *
 * Module-level state on purpose, documented like `useSnapshots`: one repo is
 * active at a time, and every consumer (the merge editor, the resolve-auto
 * summary, the apply-from-preview orchestrator) must see the same set. A
 * per-call instance would let the summary modal and the button that acts on it
 * disagree, which is the class of bug this composable exists to fix.
 *
 * Why the exclusion lives here and not in `GitWandOptions`: the core answers
 * "what *can* be resolved", which is a pure function of the conflict. "What
 * the user chose not to apply" is UI state with no stable identity across
 * re-resolves, so pushing it into the engine would mean re-running the engine
 * on every checkbox. Contrast `wouldApplyAtThreshold`, which *is* a pure
 * function of the engine's own output and therefore does belong in core.
 *
 * ── On positional indices ──
 *
 * Hunks are addressed by their position within the file, because that is the
 * currency every existing apply primitive already speaks
 * (`buildPartialContent`, `replaceConflictByIndex`, `resolveHunkCustom`).
 * Inventing stable hunk ids would mean threading them through all of those.
 *
 * The cost is index drift, handled in exactly two ways:
 *   - after a filtered apply we know precisely which indices were consumed,
 *     so `remapAfterApply` renumbers the survivors deterministically;
 *   - after any other content change we **fail closed** and drop the file's
 *     entry. Everything re-ticks, which is visibly wrong-but-safe, whereas
 *     stale indices silently exclude the wrong hunk. Same reasoning as the
 *     stale-content guard in `useGitWand.resolveHunkCustom`.
 */

import { ref } from "vue";

/** The shape this module needs from a core `HunkResolution`. */
export interface SelectableResolution {
  autoResolved: boolean;
  resolvedLines: string[] | null;
  hunk: { confidence: { score: number } };
}

interface FileSelection {
  /** Fingerprint of the content the indices were computed against. */
  contentStamp: string;
  /** Positional indices the user opted out of. */
  indices: Set<number>;
}

/**
 * Cheap, deterministic content fingerprint (FNV-1a 32-bit plus the length).
 *
 * Not a security hash: it only needs to change when the content changes, so
 * that a stale selection is dropped rather than applied to the wrong hunk.
 * The length guards the cases where a 32-bit hash is most likely to collide.
 */
export function contentStamp(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${content.length}:${(h >>> 0).toString(36)}`;
}

// ─── Module-level state ─────────────────────────────────────
const minScore = ref(0);
const excludedByFile = ref<Map<string, FileSelection>>(new Map());

/**
 * Return the live entry for `filePath`, dropping it first when `stamp` is
 * supplied and no longer matches. Every read goes through here so no caller
 * can accidentally bypass the fail-closed check.
 */
function entryFor(filePath: string, stamp?: string): FileSelection | undefined {
  const entry = excludedByFile.value.get(filePath);
  if (!entry) return undefined;
  if (stamp !== undefined && entry.contentStamp !== stamp) {
    const next = new Map(excludedByFile.value);
    next.delete(filePath);
    excludedByFile.value = next;
    return undefined;
  }
  return entry;
}

function writeIndices(filePath: string, indices: Set<number>, stamp: string): void {
  const next = new Map(excludedByFile.value);
  if (indices.size === 0) next.delete(filePath);
  else next.set(filePath, { contentStamp: stamp, indices });
  excludedByFile.value = next;
}

export function useResolutionSelection() {
  /** Has the user opted this hunk out? */
  function isExcluded(filePath: string, index: number, stamp?: string): boolean {
    return entryFor(filePath, stamp)?.indices.has(index) ?? false;
  }

  /**
   * The single predicate every apply path consults.
   *
   * Reads `autoResolved` first, so everything the engine already refused
   * (policy, the label gate, `complex` / `token_level_merge` /
   * `generated_file` / `llm_proposed`) stays refused here regardless of the
   * user's ticks. This can only ever narrow what the engine offered.
   */
  function shouldApply(
    filePath: string,
    index: number,
    resolution: SelectableResolution,
    stamp?: string,
  ): boolean {
    if (!resolution.autoResolved || resolution.resolvedLines === null) return false;
    if (resolution.hunk.confidence.score < minScore.value) return false;
    return !isExcluded(filePath, index, stamp);
  }

  /** Flip one hunk's opt-out. */
  function toggle(filePath: string, index: number, stamp: string): void {
    const entry = entryFor(filePath, stamp);
    const indices = new Set(entry?.indices ?? []);
    if (indices.has(index)) indices.delete(index);
    else indices.add(index);
    writeIndices(filePath, indices, stamp);
  }

  /** Force one hunk's opt-out to a given value. */
  function setExcluded(
    filePath: string,
    index: number,
    excluded: boolean,
    stamp: string,
  ): void {
    const entry = entryFor(filePath, stamp);
    const indices = new Set(entry?.indices ?? []);
    if (excluded) indices.add(index);
    else indices.delete(index);
    writeIndices(filePath, indices, stamp);
  }

  /**
   * Renumber after a filtered apply consumed `appliedIndices`.
   *
   * The surviving conflict blocks keep their relative order, so old index `s`
   * becomes its rank among the survivors. An exclusion whose hunk was applied
   * anyway has nothing left to point at and is dropped rather than allowed to
   * land on an unrelated block.
   */
  function remapAfterApply(
    filePath: string,
    appliedIndices: number[],
    newContentStamp: string,
  ): void {
    const entry = excludedByFile.value.get(filePath);
    if (!entry) return;

    const applied = new Set(appliedIndices);
    const remapped = new Set<number>();
    // Survivors are every old index not consumed, in ascending order. An
    // excluded index's new position is its rank in that sequence.
    const highest = Math.max(
      ...entry.indices,
      ...(appliedIndices.length ? appliedIndices : [-1]),
    );
    let rank = 0;
    for (let old = 0; old <= highest; old++) {
      if (applied.has(old)) continue;
      if (entry.indices.has(old)) remapped.add(rank);
      rank++;
    }
    writeIndices(filePath, remapped, newContentStamp);
  }

  /** How many hunks the user opted out of in this file. */
  function excludedCount(filePath: string): number {
    return excludedByFile.value.get(filePath)?.indices.size ?? 0;
  }

  function resetFile(filePath: string): void {
    const next = new Map(excludedByFile.value);
    next.delete(filePath);
    excludedByFile.value = next;
  }

  function resetAll(): void {
    excludedByFile.value = new Map();
  }

  return {
    minScore,
    excludedByFile,
    isExcluded,
    shouldApply,
    toggle,
    setExcluded,
    remapAfterApply,
    excludedCount,
    resetFile,
    resetAll,
  };
}

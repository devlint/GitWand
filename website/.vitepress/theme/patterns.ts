/**
 * Resolution patterns, mirrored from packages/core/src/classifier.ts.
 *
 * Technical names, deliberately not localised: they are the identifiers the
 * engine emits in its decision trace, and they read the same in every locale.
 *
 * - `registry: true`  a pattern in the classifier registry, evaluated in
 *   priority order until one matches.
 * - `registry: false` not a classifier pattern at all. `generated_file` is a
 *   post-classification pass that rescues `complex` hunks whose path matches a
 *   generated-file glob (packages/core/src/resolver/generated-detection.ts).
 * - `auto: true` resolved without human confirmation.
 *
 * Keep in sync with the classifier. `AUTO_PATTERN_COUNT` is derived, so the
 * homepage stats bar follows automatically; the localised "8 deterministic
 * patterns" strings in HomeLanding.vue are still hand-written and have to be
 * updated alongside it.
 */
export type ResolutionPattern = {
  /** Identifier emitted in the decision trace. */
  name: string
  /** Indicative label only: every hunk carries a computed composite score. */
  conf: 'certain' | 'high' | 'medium' | 'low'
  /** Resolved without asking the user. */
  auto: boolean
  /** Lives in the classifier registry, as opposed to a post-classification pass. */
  registry: boolean
  desc: string
}

export const PATTERNS: readonly ResolutionPattern[] = [
  { name: 'same_change',             conf: 'certain', auto: true,  registry: true,  desc: 'Both branches made the exact same edit.' },
  { name: 'one_side_change',         conf: 'certain', auto: true,  registry: true,  desc: 'Only one branch touched this block.' },
  { name: 'delete_no_change',        conf: 'certain', auto: true,  registry: true,  desc: 'One side deleted the block, the other left it untouched.' },
  { name: 'non_overlapping',         conf: 'high',    auto: true,  registry: true,  desc: 'Additions at different positions in the block.' },
  { name: 'whitespace_only',         conf: 'high',    auto: true,  registry: true,  desc: 'Same logic, different indentation or spacing.' },
  { name: 'reorder_only',            conf: 'high',    auto: true,  registry: true,  desc: 'Same lines, different order.' },
  { name: 'insertion_at_boundary',   conf: 'high',    auto: true,  registry: true,  desc: 'New lines added at the edge of a hunk.' },
  { name: 'value_only_change',       conf: 'high',    auto: true,  registry: true,  desc: 'A scalar value (version, timestamp, hash) updated on both sides — keeps the higher semver / later timestamp.' },
  { name: 'token_level_merge',       conf: 'medium',  auto: false, registry: true,  desc: 'Both sides changed disjoint tokens on the same line — proposes a merge you confirm, never auto-applied.' },
  { name: 'refactoring_aware_merge', conf: 'high',    auto: false, registry: true,  desc: 'Rename/move detected and replayed across the conflict (opt-in).' },
  { name: 'llm_proposed',            conf: 'medium',  auto: false, registry: true,  desc: 'AI-proposed resolution, validated post-merge (opt-in).' },
  { name: 'complex',                 conf: 'low',     auto: false, registry: true,  desc: 'Overlapping edits — surfaced with full classification trace.' },
  { name: 'generated_file',          conf: 'high',    auto: true,  registry: false, desc: 'Path matches a generated-file glob (lockfile, minified bundle, dist/). Reclassified out of complex and resolved to theirs: the file will be regenerated.' },
]

/** Registry patterns that auto-apply: the number the site claims. */
export const AUTO_PATTERN_COUNT = PATTERNS.filter((p) => p.auto && p.registry).length

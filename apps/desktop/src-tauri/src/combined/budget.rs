//! Total payload budget of a combined diff (apps/desktop/CLAUDE.md: a command
//! that can answer more than 1 MB truncates in Rust). The per-file 5 MB cap of
//! the diff parser bounds one entry, not `steps` × N commits, so the whole
//! answer is bounded here too.
//!
//! Mirrored by `combinedApplyBudget` in `dev-server.mjs`: same constants, same
//! size measure, same order, same tie-breaks (parity-tested).

use crate::types::{CombinedFallbackFile, GitDiff};
use std::collections::{BTreeMap, BTreeSet};

/// 16 MB of estimated payload over `diffs`, `steps` and the fallback's
/// per-commit diffs.
pub(crate) const COMBINED_BUDGET_BYTES: usize = 16 * 1024 * 1024;

/// Serialized overhead counted per hunk line on top of its content: the JSON
/// keys and values of `type`, line numbers, quotes and separators (about
/// 60 bytes as serde writes a `DiffLine`). Without it, many short lines —
/// a minified file, a long list — would weigh a fraction of their payload.
pub(crate) const LINE_OVERHEAD_BYTES: usize = 64;

/// Serialized overhead counted per entry (`GitDiff`): path, status, hunk
/// headers and the object around them.
pub(crate) const FILE_OVERHEAD_BYTES: usize = 256;

/// What an entry's hunk lines weigh: content bytes (UTF-8) plus
/// `LINE_OVERHEAD_BYTES` each. What a header-only cut saves.
fn lines_weight(d: &GitDiff) -> usize {
    d.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .map(|l| l.content.len() + LINE_OVERHEAD_BYTES)
        .sum()
}

/// What an entry weighs in the payload: `FILE_OVERHEAD_BYTES` plus its
/// lines. What dropping a step entry saves.
pub(crate) fn weight(d: &GitDiff) -> usize {
    FILE_OVERHEAD_BYTES + lines_weight(d)
}

/// Union-find root of `name`, path-compressed.
pub(crate) fn root(parent: &mut BTreeMap<String, String>, name: &str) -> String {
    let mut cur = name.to_string();
    loop {
        let next = parent
            .entry(cur.clone())
            .or_insert_with(|| cur.clone())
            .clone();
        if next == cur {
            break;
        }
        cur = next;
    }
    let mut walk = name.to_string();
    while walk != cur {
        let next = parent[&walk].clone();
        parent.insert(walk, cur.clone());
        walk = next;
    }
    cur
}

/// What [`apply_budget`] cut.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct BudgetCut {
    /// Anything was cut (steps and/or entries).
    pub truncated: bool,
    /// Paths with an entry made header-only by step (b), sorted, unique —
    /// unlike an entry over the parser's 5 MB per-file cap, its
    /// `truncated_from_bytes` is an estimated weight, not the file's size.
    pub omitted: Vec<String>,
}

/// Brings the payload under `budget` bytes.
///
/// (a) Step entries go first, one file at a time — a file being every name
///     its step entries link by renames, so a file loses all its steps or
///     none (partial steps would attribute lines wrongly; no steps just means
///     no markers). Largest file first, ties by smallest name.
/// (b) Then, if still over, the entries whose lines weigh most (net or
///     per-commit) become header-only with `truncated_from_bytes` set to the
///     weight dropped (always > 0). Ties keep payload order (net diffs, then
///     fallback files and their commits in order).
///
/// Weights are estimates of the serialized payload (`weight`). An entry with
/// no hunk line is never made header-only: that saves nothing.
pub(crate) fn apply_budget(
    diffs: &mut [GitDiff],
    steps: &mut [Vec<GitDiff>],
    fallback: &mut [CombinedFallbackFile],
    budget: usize,
) -> BudgetCut {
    let mut total: usize = diffs.iter().map(weight).sum::<usize>()
        + steps.iter().flatten().map(weight).sum::<usize>()
        + fallback
            .iter()
            .flat_map(|f| f.per_commit.iter())
            .map(|p| weight(&p.diff))
            .sum::<usize>();
    if total <= budget {
        return BudgetCut::default();
    }
    let mut cut = false;
    let mut omitted: BTreeSet<String> = BTreeSet::new();

    // (a) Group step entries into files (names linked by renames).
    let mut parent: BTreeMap<String, String> = BTreeMap::new();
    for d in steps.iter().flatten() {
        let a = root(&mut parent, &d.path);
        if let Some(old) = &d.old_path {
            let b = root(&mut parent, old);
            if a != b {
                // Smallest name as root: deterministic, and it is the tie-break.
                let (lo, hi) = if a < b { (a, b) } else { (b, a) };
                parent.insert(hi, lo);
            }
        }
    }
    let mut groups: BTreeMap<String, usize> = BTreeMap::new();
    for d in steps.iter().flatten() {
        let r = root(&mut parent, &d.path);
        *groups.entry(r).or_default() += weight(d);
    }
    let mut order: Vec<(String, usize)> = groups.into_iter().filter(|(_, s)| *s > 0).collect();
    // Stable: equal sizes keep the BTreeMap (name) order.
    order.sort_by_key(|g| std::cmp::Reverse(g.1));
    let mut dropped: BTreeSet<String> = BTreeSet::new();
    for (name, s) in order {
        if total <= budget {
            break;
        }
        total -= s;
        dropped.insert(name);
        cut = true;
    }
    if !dropped.is_empty() {
        for step in steps.iter_mut() {
            step.retain(|d| !dropped.contains(&root(&mut parent, &d.path)));
        }
    }

    // (b) Header-only entries, largest first.
    if total > budget {
        let mut entries: Vec<&mut GitDiff> = diffs
            .iter_mut()
            .chain(
                fallback
                    .iter_mut()
                    .flat_map(|f| f.per_commit.iter_mut())
                    .map(|p| &mut p.diff),
            )
            .collect();
        let mut by_size: Vec<(usize, usize)> = entries
            .iter()
            .enumerate()
            .map(|(i, d)| (i, lines_weight(d)))
            .filter(|(_, s)| *s > 0)
            .collect();
        by_size.sort_by_key(|e| std::cmp::Reverse(e.1));
        for (i, s) in by_size {
            if total <= budget {
                break;
            }
            let d = &mut entries[i];
            d.hunks.clear();
            d.truncated_from_bytes = Some(s as u64);
            omitted.insert(d.path.clone());
            total -= s;
            cut = true;
        }
    }
    BudgetCut {
        truncated: cut,
        omitted: omitted.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CombinedFallbackCommitDiff, DiffHunk, DiffLine};

    /// An entry of `lines` hunk lines of `bytes` bytes each.
    fn lines_entry(path: &str, old: Option<&str>, lines: usize, bytes: usize) -> GitDiff {
        GitDiff {
            path: path.to_string(),
            hunks: vec![DiffHunk {
                header: "@@ -0,0 +1,1 @@".to_string(),
                old_start: 0,
                old_count: 0,
                new_start: 1,
                new_count: lines as i32,
                lines: (0..lines)
                    .map(|i| DiffLine {
                        r#type: "add".to_string(),
                        content: "x".repeat(bytes),
                        old_line_no: None,
                        new_line_no: Some(i as i32 + 1),
                    })
                    .collect(),
            }],
            status: old.map(|_| "renamed".to_string()),
            old_path: old.map(str::to_string),
            truncated_from_bytes: None,
            is_directory: None,
            new_files: None,
            nested_repo: None,
        }
    }

    /// An entry of one hunk line of `bytes` bytes.
    fn entry(path: &str, old: Option<&str>, bytes: usize) -> GitDiff {
        lines_entry(path, old, 1, bytes)
    }

    /// What `entry(_, _, bytes)` weighs.
    fn w(bytes: usize) -> usize {
        FILE_OVERHEAD_BYTES + LINE_OVERHEAD_BYTES + bytes
    }

    fn names(step: &[GitDiff]) -> Vec<&str> {
        step.iter().map(|d| d.path.as_str()).collect()
    }

    #[test]
    fn weight_counts_file_and_line_overhead() {
        assert_eq!(weight(&entry("a", None, 10)), 256 + 64 + 10);
        assert_eq!(weight(&lines_entry("a", None, 3, 2)), 256 + 3 * (64 + 2));
        let mut empty = entry("a", None, 0);
        empty.hunks.clear();
        assert_eq!(weight(&empty), 256);
    }

    /// The review's case: a thousand one-byte lines weigh 1 KB of content
    /// but 65 KB of payload — the budget must see the 65 KB.
    #[test]
    fn many_short_lines_trigger_the_budget() {
        let mut diffs = vec![lines_entry("a", None, 1000, 1)];
        assert_eq!(
            apply_budget(&mut diffs, &mut [], &mut [], 10_000),
            BudgetCut {
                truncated: true,
                omitted: vec!["a".to_string()]
            }
        );
        assert!(diffs[0].hunks.is_empty());
        assert_eq!(diffs[0].truncated_from_bytes, Some(1000 * 65));
    }

    #[test]
    fn under_budget_changes_nothing() {
        let mut diffs = vec![entry("a", None, 10)];
        let mut steps = vec![vec![entry("a", None, 10)]];
        let before = (diffs.clone(), steps.clone());
        assert_eq!(
            apply_budget(&mut diffs, &mut steps, &mut [], 2 * w(10)),
            BudgetCut::default()
        );
        assert_eq!((diffs, steps), before);
    }

    #[test]
    fn steps_go_first_largest_file_first() {
        let mut diffs = vec![entry("a", None, 10), entry("b", None, 10)];
        let mut steps = vec![
            vec![entry("a", None, 10), entry("b", None, 1000)],
            vec![entry("a", None, 10)],
        ];
        // Files: a = 2 × w(10), b = w(1000), the larger; dropping b is enough.
        let total = 4 * w(10) + w(1000);
        let cut = apply_budget(&mut diffs, &mut steps, &mut [], total - w(1000));
        assert!(cut.truncated);
        // Steps only: no entry was made header-only.
        assert!(cut.omitted.is_empty());
        assert_eq!(names(&steps[0]), vec!["a"]);
        assert_eq!(names(&steps[1]), vec!["a"]);
        assert!(diffs.iter().all(|d| d.truncated_from_bytes.is_none()));
    }

    #[test]
    fn a_renamed_file_loses_all_its_steps_together() {
        let mut diffs = vec![entry("p2", Some("p"), 5)];
        let mut steps = vec![
            vec![entry("p", None, 20), entry("q", None, 25)],
            vec![entry("p2", Some("p"), 20)],
        ];
        // p+p2 weigh 2 × w(20) as one file, more than q.
        let total = w(5) + 2 * w(20) + w(25);
        assert!(apply_budget(&mut diffs, &mut steps, &mut [], total - 2 * w(20)).truncated);
        assert_eq!(names(&steps[0]), vec!["q"]);
        assert!(steps[1].is_empty());
    }

    #[test]
    fn equal_sizes_drop_the_smallest_name_first() {
        let mut steps = vec![vec![entry("b", None, 10), entry("a", None, 10)]];
        assert!(apply_budget(&mut [], &mut steps, &mut [], w(10) + 10).truncated);
        assert_eq!(names(&steps[0]), vec!["b"]);
    }

    #[test]
    fn then_entries_become_header_only_largest_first() {
        let mut diffs = vec![entry("a", None, 10), entry("b", None, 40)];
        let mut steps = vec![vec![entry("a", None, 10)]];
        let mut fallback = vec![CombinedFallbackFile {
            path: "c".to_string(),
            conflicted: true,
            per_commit: vec![CombinedFallbackCommitDiff {
                hash: "h".to_string(),
                diff: entry("c", None, 30),
            }],
            blockers: Vec::new(),
        }];
        // Steps go, then b's lines (64 + 40, the most): header-only keeps
        // the file overhead.
        let total = w(10) + w(40) + w(10) + w(30);
        let budget = total - w(10) - (64 + 40);
        let cut = apply_budget(&mut diffs, &mut steps, &mut fallback, budget);
        assert!(cut.truncated);
        assert_eq!(cut.omitted, vec!["b".to_string()]);
        assert!(steps[0].is_empty());
        assert!(diffs[1].hunks.is_empty());
        assert_eq!(diffs[1].truncated_from_bytes, Some(64 + 40));
        assert!(diffs[0].truncated_from_bytes.is_none());
        assert!(fallback[0].per_commit[0]
            .diff
            .truncated_from_bytes
            .is_none());
    }

    #[test]
    fn fallback_entries_are_cut_too() {
        let mut diffs = vec![entry("a", None, 10)];
        let mut fallback = vec![CombinedFallbackFile {
            path: "c".to_string(),
            conflicted: false,
            per_commit: vec![CombinedFallbackCommitDiff {
                hash: "h".to_string(),
                diff: entry("c", None, 30),
            }],
            blockers: Vec::new(),
        }];
        let cut = apply_budget(&mut diffs, &mut [], &mut fallback, w(10) + w(30) - 1);
        assert!(cut.truncated);
        assert_eq!(cut.omitted, vec!["c".to_string()]);
        assert_eq!(
            fallback[0].per_commit[0].diff.truncated_from_bytes,
            Some(64 + 30)
        );
        assert!(diffs[0].truncated_from_bytes.is_none());
    }
}

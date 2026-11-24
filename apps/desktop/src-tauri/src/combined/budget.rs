//! Total payload budget of a combined diff (apps/desktop/CLAUDE.md: a command
//! that can answer more than 1 MB truncates in Rust). The per-file 5 MB cap of
//! the diff parser bounds one entry, not `steps` × N commits, so the whole
//! answer is bounded here too.
//!
//! Mirrored by `combinedApplyBudget` in `dev-server.mjs`: same constant, same
//! size measure, same order, same tie-breaks (parity-tested).

use crate::types::{CombinedFallbackFile, GitDiff};
use std::collections::{BTreeMap, BTreeSet};

/// 16 MB of hunk line content over `diffs`, `steps` and the fallback's
/// per-commit diffs.
pub(crate) const COMBINED_BUDGET_BYTES: usize = 16 * 1024 * 1024;

/// What an entry weighs: the bytes of its hunk lines' content (UTF-8).
fn size(d: &GitDiff) -> usize {
    d.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .map(|l| l.content.len())
        .sum()
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

/// Brings the payload under `budget` bytes. Returns whether anything was cut.
///
/// (a) Step entries go first, one file at a time — a file being every name
///     its step entries link by renames, so a file loses all its steps or
///     none (partial steps would attribute lines wrongly; no steps just means
///     no markers). Largest file first, ties by smallest name.
/// (b) Then, if still over, the largest net or per-commit entries become
///     header-only with `truncated_from_bytes` set to the bytes dropped.
///     Ties keep payload order (net diffs, then fallback files and their
///     commits in order).
///
/// Entries that weigh nothing are never cut: cutting them saves nothing.
pub(crate) fn apply_budget(
    diffs: &mut [GitDiff],
    steps: &mut [Vec<GitDiff>],
    fallback: &mut [CombinedFallbackFile],
    budget: usize,
) -> bool {
    let mut total: usize = diffs.iter().map(size).sum::<usize>()
        + steps.iter().flatten().map(size).sum::<usize>()
        + fallback
            .iter()
            .flat_map(|f| f.per_commit.iter())
            .map(|p| size(&p.diff))
            .sum::<usize>();
    if total <= budget {
        return false;
    }
    let mut cut = false;

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
        *groups.entry(r).or_default() += size(d);
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
            .map(|(i, d)| (i, size(d)))
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
            total -= s;
            cut = true;
        }
    }
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CombinedFallbackCommitDiff, DiffHunk, DiffLine};

    /// An entry whose hunk lines weigh `bytes`.
    fn entry(path: &str, old: Option<&str>, bytes: usize) -> GitDiff {
        GitDiff {
            path: path.to_string(),
            hunks: vec![DiffHunk {
                header: "@@ -0,0 +1,1 @@".to_string(),
                old_start: 0,
                old_count: 0,
                new_start: 1,
                new_count: 1,
                lines: vec![DiffLine {
                    r#type: "add".to_string(),
                    content: "x".repeat(bytes),
                    old_line_no: None,
                    new_line_no: Some(1),
                }],
            }],
            status: old.map(|_| "renamed".to_string()),
            old_path: old.map(str::to_string),
            truncated_from_bytes: None,
            is_directory: None,
            new_files: None,
            nested_repo: None,
        }
    }

    fn names(step: &[GitDiff]) -> Vec<&str> {
        step.iter().map(|d| d.path.as_str()).collect()
    }

    #[test]
    fn under_budget_changes_nothing() {
        let mut diffs = vec![entry("a", None, 10)];
        let mut steps = vec![vec![entry("a", None, 10)]];
        let before = (diffs.clone(), steps.clone());
        assert!(!apply_budget(&mut diffs, &mut steps, &mut [], 20));
        assert_eq!((diffs, steps), before);
    }

    #[test]
    fn steps_go_first_largest_file_first() {
        let mut diffs = vec![entry("a", None, 10), entry("b", None, 10)];
        let mut steps = vec![
            vec![entry("a", None, 10), entry("b", None, 30)],
            vec![entry("a", None, 10)],
        ];
        // 20 + 50 = 70; budget 45: dropping b (30) is enough.
        assert!(apply_budget(&mut diffs, &mut steps, &mut [], 45));
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
        // p+p2 weigh 40 as one file, q 25: total 5 + 65 = 70, budget 40.
        assert!(apply_budget(&mut diffs, &mut steps, &mut [], 40));
        assert_eq!(names(&steps[0]), vec!["q"]);
        assert!(steps[1].is_empty());
    }

    #[test]
    fn equal_sizes_drop_the_smallest_name_first() {
        let mut steps = vec![vec![entry("b", None, 10), entry("a", None, 10)]];
        assert!(apply_budget(&mut [], &mut steps, &mut [], 15));
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
        // 10 + 40 + 10 + 30 = 90; budget 45: steps (10) go, then b (40).
        assert!(apply_budget(&mut diffs, &mut steps, &mut fallback, 45));
        assert!(steps[0].is_empty());
        assert!(diffs[1].hunks.is_empty());
        assert_eq!(diffs[1].truncated_from_bytes, Some(40));
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
        assert!(apply_budget(&mut diffs, &mut [], &mut fallback, 20));
        assert_eq!(
            fallback[0].per_commit[0].diff.truncated_from_bytes,
            Some(30)
        );
        assert!(diffs[0].truncated_from_bytes.is_none());
    }
}

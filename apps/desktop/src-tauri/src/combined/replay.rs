//! The replay engine behind `git_combined_diff` (spec §5.2).
//!
//! The selected commits are replayed, ancestors first, onto the first parent
//! of the oldest one. Each replay step is a three-way merge whose only merge
//! base is the tree of `Ci^`, done in memory by `git merge-tree --write-tree`
//! on synthetic commits. Files a step cannot merge cleanly leave the net view
//! and are shown commit by commit instead (the "fallback").
//!
//! Nothing here touches the worktree, the index, HEAD or any ref: the only
//! writes are unreachable objects (trees from `merge-tree`, the synthetic
//! commits, the empty tree), which `git gc` collects.

use super::order::resolve_and_order;
use super::{supports_combined_diff, validate_hashes};
use crate::commands::read::parse_multi_file_diff_capped;
use crate::git::git_cmd;
use crate::stack::guard::git_version;
use crate::types::{
    CombinedDiff, CombinedFallbackCommitDiff, CombinedFallbackFile, GitDiff, DIFF_TRUNCATE_BYTES,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::process::{Command, Output, Stdio};

/// Most blockers named per fallback file.
const MAX_BLOCKERS: &str = "5";

/// Fixed identity for the synthetic commits: they never depend on the user's
/// config and are deterministic (same inputs → same object ids).
const SYNTHETIC_ENV: [(&str, &str); 6] = [
    ("GIT_AUTHOR_NAME", "GitWand"),
    ("GIT_AUTHOR_EMAIL", "combined-diff@gitwand.local"),
    ("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z"),
    ("GIT_COMMITTER_NAME", "GitWand"),
    ("GIT_COMMITTER_EMAIL", "combined-diff@gitwand.local"),
    ("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z"),
];

/// A selected commit as the replay needs it.
struct Replayed {
    hash: String,
    tree: String,
    /// First parent, `None` for a root commit.
    parent: Option<String>,
    /// Tree of the first parent, `None` for a root commit (the empty tree).
    parent_tree: Option<String>,
}

struct Repo<'a> {
    cwd: &'a str,
    /// `None` = whole repository.
    paths: Option<&'a [String]>,
    empty_tree: Option<String>,
}

impl<'a> Repo<'a> {
    /// A git command pinned against config that would change its output.
    fn git(&self) -> Command {
        let mut cmd = git_cmd();
        cmd.args([
            "-c",
            "diff.noprefix=false",
            "-c",
            "diff.mnemonicPrefix=false",
            "-c",
            "core.quotePath=false",
            // Same rename budget as the merge below, so the diffs see the
            // renames `merge-tree` acts on.
            "-c",
            "diff.renameLimit=7000",
        ])
        .current_dir(self.cwd)
        .stdin(Stdio::null());
        cmd
    }

    fn output(&self, mut cmd: Command, what: &str) -> Result<Output, String> {
        cmd.output()
            .map_err(|e| format!("Failed to run git {what}: {e}"))
    }

    fn stdout(&self, cmd: Command, what: &str) -> Result<String, String> {
        let out = self.output(cmd, what)?;
        if !out.status.success() {
            return Err(format!(
                "git {what} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Appends `-- <paths>` (literal pathspecs) when a filter is set.
    fn pathspec(&self, cmd: &mut Command, extra: &[&str]) {
        cmd.arg("--");
        if let Some(paths) = self.paths {
            cmd.args(paths);
        }
        cmd.args(extra);
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    }

    fn in_paths(&self, path: &str) -> bool {
        match self.paths {
            None => true,
            Some(paths) => paths.iter().any(|q| {
                let q = q.trim_end_matches('/');
                path == q || path.strip_prefix(q).is_some_and(|r| r.starts_with('/'))
            }),
        }
    }

    /// The empty tree, written (never hard-coded: its id depends on the
    /// object format).
    fn empty_tree(&mut self) -> Result<String, String> {
        if let Some(t) = &self.empty_tree {
            return Ok(t.clone());
        }
        let mut cmd = self.git();
        cmd.args(["hash-object", "-t", "tree", "-w", "--stdin"]);
        let t = self.stdout(cmd, "hash-object")?.trim().to_string();
        self.empty_tree = Some(t.clone());
        Ok(t)
    }

    /// `hash → (tree, first parent)` for `hashes`, in one spawn.
    fn trees_and_parents(
        &self,
        hashes: &[String],
    ) -> Result<HashMap<String, (String, Option<String>)>, String> {
        let mut cmd = self.git();
        cmd.args([
            "log",
            "--no-walk=unsorted",
            "--no-show-signature",
            "--no-color",
            "--format=%H%x00%T%x00%P",
            "--end-of-options",
        ])
        .args(hashes);
        let out = self.stdout(cmd, "log")?;
        let mut map = HashMap::new();
        for line in out.lines() {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() != 3 {
                continue;
            }
            let parent = f[2].split(' ').find(|p| !p.is_empty()).map(str::to_string);
            map.insert(f[0].to_string(), (f[1].to_string(), parent));
        }
        for h in hashes {
            if !map.contains_key(h) {
                return Err(format!("Could not read commit metadata: {h}"));
            }
        }
        Ok(map)
    }

    fn commit_tree(&self, tree: &str, parent: Option<&str>) -> Result<String, String> {
        let mut cmd = self.git();
        cmd.args(["-c", "commit.gpgSign=false", "commit-tree", tree]);
        if let Some(p) = parent {
            cmd.args(["-p", p]);
        }
        cmd.args(["-m", "GitWand combined diff"]);
        for (k, v) in SYNTHETIC_ENV {
            cmd.env(k, v);
        }
        Ok(self.stdout(cmd, "commit-tree")?.trim().to_string())
    }

    /// Three-way merge of `ours` and `theirs` onto `base` (all trees).
    /// Returns the result tree and, when it conflicted, the conflicted paths.
    fn merge(
        &self,
        base: &str,
        ours: &str,
        theirs: &str,
    ) -> Result<(String, Option<Vec<String>>), String> {
        // P has no parent, B1/B2 have only P: P is their sole merge base, so
        // no `--merge-base` (git 2.40) is needed.
        let p = self.commit_tree(base, None)?;
        let b1 = self.commit_tree(ours, Some(&p))?;
        let b2 = self.commit_tree(theirs, Some(&p))?;
        let mut cmd = self.git();
        // Pin every merge setting that changes the result tree: a user's
        // `merge.directoryRenames=true` would move a file into a directory
        // the other side renamed, a path no selected commit wrote.
        cmd.args([
            "-c",
            "merge.renames=true",
            "-c",
            "merge.directoryRenames=conflict",
            "-c",
            "merge.renameLimit=7000",
            "-c",
            "merge.renormalize=false",
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            &b1,
            &b2,
        ]);
        let out = self.output(cmd, "merge-tree")?;
        let code = out.status.code();
        if code != Some(0) && code != Some(1) {
            return Err(format!(
                "git merge-tree failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        // `<tree>\0<path>\0…<path>\0\0<messages>`: paths end at the first
        // empty field.
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut fields = stdout.split('\0');
        let tree = fields.next().unwrap_or("").trim().to_string();
        if tree.is_empty() {
            return Err("git merge-tree returned no tree".to_string());
        }
        if code == Some(0) {
            return Ok((tree, None));
        }
        let mut paths: Vec<String> = Vec::new();
        for f in fields.take_while(|f| !f.is_empty()) {
            if !paths.iter().any(|p| p == f) {
                paths.push(f.to_string());
            }
        }
        Ok((tree, Some(paths)))
    }

    /// `a → b` tree diff, rename-aware, each file capped at the `git_diff`
    /// truncation threshold.
    fn diff(
        &self,
        a: &str,
        b: &str,
        unified0: bool,
        extra: &[&str],
    ) -> Result<Vec<GitDiff>, String> {
        let mut cmd = self.git();
        cmd.args([
            "diff-tree",
            "-r",
            "-p",
            "-M",
            "--no-color",
            "--no-ext-diff",
            "--no-relative",
        ]);
        if unified0 {
            cmd.arg("-U0");
        }
        cmd.args([a, b]);
        self.pathspec(&mut cmd, extra);
        let out = self.stdout(cmd, "diff-tree")?;
        Ok(parse_multi_file_diff_capped(
            &out,
            Some(DIFF_TRUNCATE_BYTES),
        ))
    }

    /// Every change of a tree diff within `paths`, as `(old path of a
    /// rename, path)`.
    fn touched(&self, a: &str, b: &str) -> Result<Vec<(Option<String>, String)>, String> {
        let mut cmd = self.git();
        cmd.args([
            "diff-tree",
            "-r",
            "-M",
            "--name-status",
            "-z",
            "--no-relative",
            a,
            b,
        ]);
        self.pathspec(&mut cmd, &[]);
        let out = self.stdout(cmd, "diff-tree")?;
        let mut changes = Vec::new();
        let mut fields = out.split('\0').filter(|f| !f.is_empty());
        while let Some(status) = fields.next() {
            let first = fields.next().map(str::to_string);
            if status.starts_with('R') || status.starts_with('C') {
                if let Some(new) = fields.next() {
                    changes.push((first, new.to_string()));
                }
            } else if let Some(p) = first {
                changes.push((None, p));
            }
        }
        Ok(changes)
    }

    /// Commits outside the selection that touch `path` between the replay
    /// base / earlier selected commits and `Ci^`, at most `MAX_BLOCKERS`.
    fn blockers(
        &self,
        parent: &str,
        base: Option<&str>,
        earlier: &[&str],
        path: &str,
    ) -> Result<Vec<String>, String> {
        let mut cmd = self.git();
        cmd.args(["rev-list", "--max-count", MAX_BLOCKERS, parent, "--not"]);
        if let Some(b) = base {
            cmd.arg(b);
        }
        cmd.args(earlier);
        cmd.args(["--", path]);
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
        Ok(self
            .stdout(cmd, "rev-list")?
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }
}

/// Rename pairs with one side in the fallback bring the other side in,
/// inheriting its blockers, until nothing changes.
fn join_pairs(fallback: &mut BTreeMap<String, Vec<String>>, pairs: &[(String, String)]) {
    loop {
        let mut joined = false;
        for (a, b) in pairs {
            for (from, to) in [(a, b), (b, a)] {
                if !fallback.contains_key(to) {
                    if let Some(blockers) = fallback.get(from).cloned() {
                        fallback.insert(to.clone(), blockers);
                        joined = true;
                    }
                }
            }
        }
        if !joined {
            return;
        }
    }
}

fn rename_pairs(diffs: &[GitDiff]) -> Vec<(String, String)> {
    diffs
        .iter()
        .filter_map(|d| d.old_path.clone().map(|o| (o, d.path.clone())))
        .collect()
}

fn touches(d: &GitDiff, set: &BTreeMap<String, Vec<String>>) -> bool {
    set.contains_key(&d.path) || d.old_path.as_ref().is_some_and(|p| set.contains_key(p))
}

/// The combined diff of `hashes` (any order), optionally limited to `paths`.
pub(crate) fn combined_diff(
    cwd: &str,
    hashes: &[String],
    paths: Option<&[String]>,
) -> Result<CombinedDiff, String> {
    let version = git_version();
    if !supports_combined_diff(version) {
        let found = version
            .map(|(a, b)| format!("{a}.{b}"))
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "Combined diffs need git 2.38 or later (found {found})."
        ));
    }
    let hashes = validate_hashes(hashes)?;
    let commits = resolve_and_order(cwd, &hashes)?;
    let mut repo = Repo {
        cwd,
        paths: paths.filter(|p| !p.is_empty()),
        empty_tree: None,
    };

    // 1. Trees and first parents of the selection and of those parents.
    let selected: Vec<String> = commits.iter().map(|c| c.hash.clone()).collect();
    let meta = repo.trees_and_parents(&selected)?;
    let mut parents: Vec<String> = Vec::new();
    for h in &selected {
        if let Some(p) = &meta[h].1 {
            if !parents.contains(p) && !meta.contains_key(p) {
                parents.push(p.clone());
            }
        }
    }
    let parent_meta = if parents.is_empty() {
        HashMap::new()
    } else {
        repo.trees_and_parents(&parents)?
    };
    let tree_of = |h: &str| -> String {
        meta.get(h)
            .or_else(|| parent_meta.get(h))
            .map(|m| m.0.clone())
            .unwrap_or_default()
    };
    let replayed: Vec<Replayed> = selected
        .iter()
        .map(|h| {
            let (tree, parent) = meta[h].clone();
            let parent_tree = parent.as_deref().map(tree_of);
            Replayed {
                hash: h.clone(),
                tree,
                parent,
                parent_tree,
            }
        })
        .collect();

    let base = replayed[0].parent.clone();
    let base_tree = match &replayed[0].parent_tree {
        Some(t) => t.clone(),
        None => repo.empty_tree()?,
    };

    // 2. Replay, recording each step and growing the fallback set (path →
    //    blockers) on conflicted steps.
    let mut acc = base_tree.clone();
    let mut fallback: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut steps: Vec<Vec<GitDiff>> = Vec::with_capacity(replayed.len());
    for (i, c) in replayed.iter().enumerate() {
        let parent_tree = match &c.parent_tree {
            Some(t) => t.clone(),
            None => repo.empty_tree()?,
        };
        let merged = acc != parent_tree;
        let (result, conflicted) = if merged {
            repo.merge(&parent_tree, &acc, &c.tree)?
        } else {
            (c.tree.clone(), None)
        };
        let step = repo.diff(&acc, &result, true, &[])?;
        // What `Ci` itself changes. On the fast path it is the step diff.
        let ci_changes = if merged && (conflicted.is_some() || !fallback.is_empty()) {
            repo.touched(&parent_tree, &c.tree)?
        } else {
            Vec::new()
        };
        if let Some(conflicted) = conflicted {
            // `--name-only` misses paths a conflict moves (`f` → `f~<oid>`):
            // also take everything this step and `Ci` itself touch.
            let mut grown: Vec<String> = conflicted
                .into_iter()
                .filter(|p| repo.in_paths(p))
                .collect();
            for d in &step {
                grown.push(d.path.clone());
                grown.extend(d.old_path.clone());
            }
            for (old, new) in &ci_changes {
                grown.extend(old.clone());
                grown.push(new.clone());
            }
            let earlier: Vec<&str> = replayed[..i].iter().map(|r| r.hash.as_str()).collect();
            for path in grown {
                if fallback.contains_key(&path) {
                    continue;
                }
                let blockers = match &c.parent {
                    Some(p) => repo.blockers(p, base.as_deref(), &earlier, &path)?,
                    None => Vec::new(),
                };
                fallback.insert(path, blockers);
            }
        }
        // After every step, clean ones included: a rename that moves a
        // fallback path carries its content (conflict markers included) to
        // the new path, which must join the fallback. Renames come from the
        // step diff and from `Ci` itself (the side `merge-tree` followed).
        if !fallback.is_empty() {
            let mut pairs = rename_pairs(&step);
            pairs.extend(
                ci_changes
                    .iter()
                    .filter_map(|(old, new)| old.clone().map(|o| (o, new.clone()))),
            );
            join_pairs(&mut fallback, &pairs);
        }
        steps.push(step);
        acc = result;
    }

    // 3. Net diff. A rename pair touching the fallback goes there whole.
    let mut diffs = repo.diff(&base_tree, &acc, false, &[])?;
    join_pairs(&mut fallback, &rename_pairs(&diffs));
    diffs.retain(|d| !touches(d, &fallback));

    // 5. Steps: no fallback file, and no file whose net diff was truncated
    //    (there are no lines to attribute) or whose own step diff was.
    let truncated: HashSet<&String> = diffs
        .iter()
        .filter(|d| d.truncated_from_bytes.is_some())
        .flat_map(|d| std::iter::once(&d.path).chain(d.old_path.iter()))
        .collect();
    let steps: Vec<Vec<GitDiff>> = steps
        .into_iter()
        .map(|step| {
            step.into_iter()
                .filter(|d| {
                    !touches(d, &fallback)
                        && d.truncated_from_bytes.is_none()
                        && !truncated.contains(&d.path)
                        && !d.old_path.as_ref().is_some_and(|p| truncated.contains(p))
                })
                .collect()
        })
        .collect();

    // 4. Per-commit diffs of the fallback files, in replay order. A rename
    //    entry belongs to its new path; to its old one only when the new path
    //    is not itself in fallback.
    let mut per_path: BTreeMap<String, Vec<CombinedFallbackCommitDiff>> = BTreeMap::new();
    if !fallback.is_empty() {
        let fb_paths: Vec<&str> = fallback.keys().map(String::as_str).collect();
        let whole = Repo {
            cwd,
            paths: None,
            empty_tree: repo.empty_tree.clone(),
        };
        for c in &replayed {
            let parent_tree = match &c.parent_tree {
                Some(t) => t.clone(),
                None => repo.empty_tree()?,
            };
            for d in whole.diff(&parent_tree, &c.tree, false, &fb_paths)? {
                let owner = if fallback.contains_key(&d.path) {
                    Some(d.path.clone())
                } else {
                    d.old_path.clone().filter(|p| fallback.contains_key(p))
                };
                if let Some(owner) = owner {
                    per_path
                        .entry(owner)
                        .or_default()
                        .push(CombinedFallbackCommitDiff {
                            hash: c.hash.clone(),
                            diff: d,
                        });
                }
            }
        }
    }
    // Fallback paths no selected commit touches are conflict artefacts.
    let fallback: Vec<CombinedFallbackFile> = fallback
        .into_iter()
        .filter_map(|(path, blockers)| {
            let per_commit = per_path.remove(&path)?;
            Some(CombinedFallbackFile {
                path,
                per_commit,
                blockers,
            })
        })
        .collect();

    Ok(CombinedDiff {
        base,
        commits,
        diffs,
        steps,
        fallback,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::read::parse_multi_file_diff;
    use crate::types::GitDiff;
    use crate::worktree::test_support::TempRepo;

    fn cwd(r: &TempRepo) -> String {
        r.path.to_string_lossy().to_string()
    }

    /// One commit from `(path, content)` pairs; `None` removes the path
    /// (file or directory).
    fn commit_files(r: &TempRepo, files: &[(&str, Option<&str>)], msg: &str) -> String {
        for (path, content) in files {
            match content {
                Some(c) => r.write(path, c),
                None => {
                    let p = r.path.join(path);
                    if p.is_dir() {
                        std::fs::remove_dir_all(p).unwrap();
                    } else {
                        std::fs::remove_file(p).unwrap();
                    }
                }
            }
        }
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", msg]);
        r.git(&["rev-parse", "HEAD"])
    }

    fn run(r: &TempRepo, hashes: &[&String], paths: Option<&[&str]>) -> CombinedDiff {
        let hashes: Vec<String> = hashes.iter().map(|h| h.to_string()).collect();
        let paths: Option<Vec<String>> = paths.map(|p| p.iter().map(|s| s.to_string()).collect());
        combined_diff(&cwd(r), &hashes, paths.as_deref()).unwrap()
    }

    fn paths_of(diffs: &[GitDiff]) -> Vec<String> {
        let mut v: Vec<String> = diffs.iter().map(|d| d.path.clone()).collect();
        v.sort();
        v
    }

    fn lines(d: &GitDiff, kind: &str) -> Vec<String> {
        d.hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.r#type == kind)
            .map(|l| l.content.clone())
            .collect()
    }

    fn ten(prefix: &str) -> String {
        (1..=10).map(|i| format!("{prefix}{i}\n")).collect()
    }

    fn git_show(r: &TempRepo, h: &str) -> Vec<GitDiff> {
        tauri::async_runtime::block_on(crate::commands::read::git_show(cwd(r), h.to_string()))
            .unwrap()
    }

    #[test]
    fn contiguous_equals_range_diff() {
        let r = TempRepo::new();
        let a = commit_files(&r, &[("f", Some("1\n")), ("g", Some("g\n"))], "A");
        let b = commit_files(&r, &[("f", Some("2\n")), ("h", Some("h\n"))], "B");
        let got = run(&r, &[&b, &a], None);
        let raw = r.git(&[
            "diff-tree",
            "-r",
            "-p",
            "-M",
            "--no-color",
            "--no-ext-diff",
            &format!("{a}^"),
            &b,
        ]);
        assert_eq!(got.diffs, parse_multi_file_diff(&raw));
        assert!(got.fallback.is_empty());
        assert_eq!(got.steps.len(), 2);
        assert_eq!(got.commits[0].hash, a);
        assert_eq!(got.base, Some(r.git(&["rev-parse", &format!("{a}^")])));
    }

    #[test]
    fn non_contiguous_clean() {
        let r = TempRepo::new();
        commit_files(&r, &[("f", Some(&ten("l"))), ("g", Some("g\n"))], "base");
        let f1 = ten("l").replacen("l1\n", "A1\n", 1);
        let a = commit_files(&r, &[("f", Some(&f1))], "A");
        let _b = commit_files(&r, &[("g", Some("g2\n"))], "B");
        let f2 = f1.replacen("l10\n", "C10\n", 1);
        let c = commit_files(&r, &[("f", Some(&f2))], "C");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(paths_of(&got.diffs), vec!["f"]);
        assert_eq!(lines(&got.diffs[0], "add"), vec!["A1", "C10"]);
        assert!(got.fallback.is_empty());
        assert_eq!(got.steps.len(), 2);
        assert_eq!(paths_of(&got.steps[1]), vec!["f"]);
    }

    /// The spec example: A `x=1→2`, B `2→3`, C `3→4` and adds `e`.
    fn overlap_repo(r: &TempRepo, files: &[&str]) -> (String, String, String) {
        let set = |content: &'static str| -> Vec<(&str, Option<&str>)> {
            files.iter().map(|f| (*f, Some(content))).collect()
        };
        commit_files(r, &set("a\nx=1\nc\n"), "base");
        let a = commit_files(r, &set("a\nx=2\nc\n"), "A");
        let b = commit_files(r, &set("a\nx=3\nc\n"), "B");
        let c = commit_files(r, &set("a\nx=4\nc\ne\n"), "C");
        (a, b, c)
    }

    #[test]
    fn overlap_falls_back_with_blocker() {
        let r = TempRepo::new();
        let (a, b, c) = overlap_repo(&r, &["f"]);
        let got = run(&r, &[&a, &c], None);
        assert!(got.diffs.iter().all(|d| d.path != "f"));
        assert_eq!(got.fallback.len(), 1);
        assert_eq!(got.fallback[0].path, "f");
        let per: Vec<&str> = got.fallback[0]
            .per_commit
            .iter()
            .map(|p| p.hash.as_str())
            .collect();
        assert_eq!(per, vec![a.as_str(), c.as_str()]);
        assert_eq!(got.fallback[0].blockers, vec![b]);
        assert!(got.steps.iter().flatten().all(|d| d.path != "f"));
    }

    #[test]
    fn conflict_between_selected_on_two_branches_has_no_blocker() {
        let r = TempRepo::new();
        commit_files(&r, &[("f", Some("x=1\n"))], "base");
        r.git(&["checkout", "-q", "-b", "b1"]);
        let x = commit_files(&r, &[("f", Some("x=2\n"))], "X");
        r.git(&["checkout", "-q", "main"]);
        r.git(&["checkout", "-q", "-b", "b2"]);
        let y = commit_files(&r, &[("f", Some("x=3\n"))], "Y");
        let got = run(&r, &[&x, &y], None);
        assert_eq!(got.fallback.len(), 1);
        assert_eq!(got.fallback[0].path, "f");
        assert!(got.fallback[0].blockers.is_empty());
        assert_eq!(got.fallback[0].per_commit.len(), 2);
    }

    #[test]
    fn file_directory_conflict_never_leaks() {
        let r = TempRepo::new();
        commit_files(&r, &[("f", Some("1\n"))], "base");
        let a = commit_files(&r, &[("f", Some("2\n"))], "A");
        let _b = commit_files(&r, &[("f", None), ("f/x", Some("x\n"))], "B");
        let c = commit_files(&r, &[("f/x", Some("y\n"))], "C");
        let got = run(&r, &[&a, &c], None);
        let leaks = |p: &str| p == "f" || p == "f/x" || p.starts_with("f~");
        for d in &got.diffs {
            assert!(!leaks(&d.path), "net leaks {}", d.path);
            assert!(!d.old_path.as_deref().is_some_and(leaks), "net leaks {d:?}");
        }
        assert!(!got.fallback.is_empty());
        for f in &got.fallback {
            assert!(f.path == "f" || f.path == "f/x", "fallback {}", f.path);
            assert!(
                !f.per_commit.is_empty(),
                "{} has no per-commit diff",
                f.path
            );
        }
        for d in got.steps.iter().flatten() {
            assert!(!leaks(&d.path), "step leaks {}", d.path);
        }
    }

    #[test]
    fn root_commit_sha256() {
        let r = TempRepo::new();
        // A fresh sha256 repo in the same sandbox.
        let dir = r.sandbox.join("sha");
        std::fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| crate::worktree::test_support::git_at(&dir, args);
        g(&["init", "-q", "-b", "main", "--object-format=sha256"]);
        g(&["config", "user.name", "Test"]);
        g(&["config", "user.email", "test@example.com"]);
        g(&["config", "commit.gpgsign", "false"]);
        let commit = |rel: &str, content: &str, msg: &str| {
            std::fs::write(dir.join(rel), content).unwrap();
            g(&["add", "-A"]);
            g(&["commit", "-q", "-m", msg]);
            g(&["rev-parse", "HEAD"])
        };
        let root = commit("a.txt", "a\n", "root");
        let _s = commit("b.txt", "b\n", "S");
        let t = commit("c.txt", "c\n", "T");
        assert_eq!(root.len(), 64);
        let got = combined_diff(&dir.to_string_lossy(), &[t.clone(), root.clone()], None).unwrap();
        assert_eq!(got.base, None);
        assert_eq!(paths_of(&got.diffs), vec!["a.txt", "c.txt"]);
        for d in &got.diffs {
            assert_eq!(d.status.as_deref(), Some("added"));
        }
        assert!(got.fallback.is_empty());
    }

    #[test]
    fn merge_commit_uses_first_parent() {
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "side"]);
        commit_files(&r, &[("s.txt", Some("s\n"))], "side");
        r.git(&["checkout", "-q", "main"]);
        commit_files(&r, &[("m.txt", Some("m\n"))], "main");
        r.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
        let m = r.git(&["rev-parse", "HEAD"]);
        let _u = commit_files(&r, &[("u.txt", Some("u\n"))], "U");
        let l = commit_files(&r, &[("l.txt", Some("l\n"))], "L");
        let got = run(&r, &[&m, &l], None);
        let mut want = paths_of(&git_show(&r, &m));
        want.push("l.txt".to_string());
        want.sort();
        assert_eq!(paths_of(&got.diffs), want);
        assert_eq!(paths_of(&got.steps[0]), paths_of(&git_show(&r, &m)));
    }

    #[test]
    fn paths_filter() {
        let r = TempRepo::new();
        let (a, _b, c) = overlap_repo(&r, &["f", "g"]);
        let d = commit_files(&r, &[("h", Some("h\n")), ("f2", Some("x\n"))], "D");
        let got = run(&r, &[&a, &c, &d], Some(&["f"]));
        assert!(got.diffs.iter().all(|d| d.path == "f"));
        assert!(got.steps.iter().flatten().all(|d| d.path == "f"));
        let fb: Vec<&str> = got.fallback.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(fb, vec!["f"]);
        for p in &got.fallback[0].per_commit {
            assert_eq!(p.diff.path, "f");
        }
    }

    #[test]
    fn rename_across_steps() {
        let r = TempRepo::new();
        commit_files(
            &r,
            &[("a.txt", Some(&ten("line "))), ("g", Some("g\n"))],
            "base",
        );
        r.git(&["mv", "a.txt", "b.txt"]);
        r.git(&["commit", "-q", "-m", "A"]);
        let a = r.git(&["rev-parse", "HEAD"]);
        let _b = commit_files(&r, &[("g", Some("g2\n"))], "B");
        let edited = ten("line ").replacen("line 5\n", "five\n", 1);
        let c = commit_files(&r, &[("b.txt", Some(&edited))], "C");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(got.diffs.len(), 1, "{:?}", got.diffs);
        assert_eq!(got.diffs[0].path, "b.txt");
        assert_eq!(got.diffs[0].status.as_deref(), Some("renamed"));
        assert_eq!(got.diffs[0].old_path.as_deref(), Some("a.txt"));
        assert!(got.fallback.is_empty());
    }

    #[test]
    fn binary_file() {
        let r = TempRepo::new();
        commit_files(&r, &[("g", Some("g\n"))], "base");
        std::fs::write(r.path.join("bin.dat"), [0u8, 1, 2, 3, 0, 255, 254]).unwrap();
        let a = commit_files(&r, &[], "A");
        let _b = commit_files(&r, &[("g", Some("g2\n"))], "B");
        let c = commit_files(&r, &[("t.txt", Some("t\n"))], "C");
        let got = run(&r, &[&a, &c], None);
        let bin = got.diffs.iter().find(|d| d.path == "bin.dat").unwrap();
        assert!(bin.hunks.is_empty());
    }

    /// Selection: A, C (overlap on `f` → fallback), G0, G1 (contiguous) and
    /// K (non-contiguous, clean on `g`).
    fn hostile_scenario(r: &TempRepo) -> Vec<String> {
        let (a, _b, c) = overlap_repo(r, &["f"]);
        let g0 = commit_files(r, &[("g", Some(&ten("l")))], "G0");
        let g1 = ten("l").replacen("l1\n", "G1\n", 1);
        let g = commit_files(r, &[("g", Some(&g1))], "G1");
        let _h = commit_files(r, &[("h", Some("h\n"))], "H");
        let k = commit_files(r, &[("g", Some(&g1.replacen("l10\n", "K\n", 1)))], "K");
        vec![a, c, g0, g, k]
    }

    #[test]
    fn hostile_config() {
        let r = TempRepo::new();
        let sel = hostile_scenario(&r);
        let sel: Vec<&String> = sel.iter().collect();
        let clean = run(&r, &sel, None);
        for (key, value) in [
            ("diff.noprefix", "true"),
            ("diff.mnemonicPrefix", "true"),
            ("color.ui", "always"),
            ("diff.external", "false"),
            ("commit.gpgSign", "true"),
            ("gpg.program", "false"),
            ("core.quotePath", "true"),
            ("log.showSignature", "true"),
            ("diff.relative", "true"),
        ] {
            r.git(&["config", key, value]);
        }
        let hostile = run(&r, &sel, None);
        assert_eq!(hostile, clean);
        assert_eq!(clean.fallback.len(), 1);
        assert_eq!(paths_of(&clean.diffs), vec!["g"]);
        assert_eq!(lines(&clean.diffs[0], "add").len(), 10);
    }

    /// A clean step that renames a fallback path must take the new path into
    /// the fallback too: its content carries the earlier conflict markers.
    #[test]
    fn clean_rename_of_a_fallback_path_stays_in_fallback() {
        let r = TempRepo::new();
        let a = commit_files(&r, &[("p", Some(&ten("l")))], "A");
        let _b = commit_files(
            &r,
            &[("p", Some(&ten("l").replacen("l5\n", "B\n", 1)))],
            "B",
        );
        let c = commit_files(
            &r,
            &[("p", Some(&ten("l").replacen("l5\n", "C\n", 1)))],
            "C",
        );
        r.git(&["mv", "p", "p2"]);
        r.git(&["commit", "-q", "-m", "D"]);
        let d = r.git(&["rev-parse", "HEAD"]);
        let got = run(&r, &[&a, &c, &d], None);
        for e in &got.diffs {
            assert!(e.path != "p" && e.path != "p2", "net leaks {e:?}");
            assert!(lines(e, "add").iter().all(|l| !l.starts_with("<<<<<<<")));
        }
        assert!(got
            .steps
            .iter()
            .flatten()
            .all(|e| e.path != "p2" && e.path != "p"));
        let p2 = got
            .fallback
            .iter()
            .find(|f| f.path == "p2")
            .expect("p2 in fallback");
        assert!(p2.per_commit.iter().any(|pc| pc.hash == d));
    }

    /// `merge-tree` must not follow the user's merge config: with
    /// `merge.directoryRenames=true` a file added in a directory the other
    /// side renamed would silently land at a path no selected commit wrote.
    #[test]
    fn hostile_merge_config() {
        let r = TempRepo::new();
        let z = commit_files(
            &r,
            &[("d/a", Some(&ten("a"))), ("d/b", Some(&ten("b")))],
            "Z",
        );
        r.git(&["checkout", "-q", "-b", "b1"]);
        r.git(&["mv", "d", "e"]);
        r.git(&["commit", "-q", "-m", "X"]);
        let x = r.git(&["rev-parse", "HEAD"]);
        r.git(&["checkout", "-q", "main"]);
        r.git(&["checkout", "-q", "-b", "b2"]);
        let y = commit_files(&r, &[("d/new", Some("new\n"))], "Y");
        let clean = run(&r, &[&z, &x, &y], None);
        assert!(clean.diffs.iter().all(|e| e.path != "e/new"));
        assert!(!clean.fallback.is_empty());
        for (key, value) in [
            ("merge.directoryRenames", "true"),
            ("merge.renames", "false"),
            ("merge.renameLimit", "1"),
            ("merge.renormalize", "true"),
            ("diff.renames", "false"),
            ("diff.renameLimit", "1"),
        ] {
            r.git(&["config", key, value]);
        }
        let hostile = run(&r, &[&z, &x, &y], None);
        assert_eq!(hostile, clean);
    }

    #[test]
    fn space_and_unicode_paths() {
        let r = TempRepo::new();
        commit_files(&r, &[("g", Some("g\n"))], "base");
        let a = commit_files(&r, &[("dir with space/é.txt", Some("1\n"))], "A");
        let _b = commit_files(&r, &[("g", Some("g2\n"))], "B");
        let c = commit_files(&r, &[("dir with space/é.txt", Some("2\n"))], "C");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(paths_of(&got.diffs), vec!["dir with space/é.txt"]);
        assert_eq!(got.diffs[0].status.as_deref(), Some("added"));
    }

    #[test]
    fn large_file_is_truncated() {
        let r = TempRepo::new();
        commit_files(&r, &[("g", Some("g\n"))], "base");
        let big: String = (0..700_000).map(|i| format!("line {i}\n")).collect();
        assert!(big.len() > crate::types::DIFF_TRUNCATE_BYTES);
        let a = commit_files(&r, &[("big.txt", Some(&big))], "A");
        let _b = commit_files(&r, &[("g", Some("g2\n"))], "B");
        let c = commit_files(&r, &[("t.txt", Some("t\n"))], "C");
        let got = run(&r, &[&a, &c], None);
        let d = got.diffs.iter().find(|d| d.path == "big.txt").unwrap();
        assert!(d.hunks.is_empty());
        assert!(d.truncated_from_bytes.unwrap() > crate::types::DIFF_TRUNCATE_BYTES as u64);
        assert!(got.steps.iter().flatten().all(|d| d.path != "big.txt"));
        let t = got.diffs.iter().find(|d| d.path == "t.txt").unwrap();
        assert!(t.truncated_from_bytes.is_none());
    }

    #[test]
    fn never_moves_refs_or_index() {
        let r = TempRepo::new();
        let sel = hostile_scenario(&r);
        let sel: Vec<&String> = sel.iter().collect();
        r.write("dirty.txt", "wip\n");
        r.git(&["add", "dirty.txt"]);
        r.write("g", "unstaged\n");
        let snap = || {
            (
                r.git(&["rev-parse", "HEAD"]),
                r.git(&["status", "--porcelain"]),
                r.git(&["for-each-ref"]),
                r.git(&["stash", "list"]),
            )
        };
        let before = snap();
        let got = run(&r, &sel, None);
        assert!(!got.fallback.is_empty(), "exercise the merge path");
        assert_eq!(snap(), before);
    }

    #[test]
    fn rejects_invalid_input_before_git() {
        let r = TempRepo::new();
        let a = r.git(&["rev-parse", "HEAD"]);
        let err = combined_diff(&cwd(&r), &[a, "--output=x".to_string()], None).unwrap_err();
        assert_eq!(err, "Invalid commit hash: --output=x");
    }
}

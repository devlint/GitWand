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

use super::budget::{apply_budget, root, COMBINED_BUDGET_BYTES};
use super::order::resolve_and_order;
use super::{supports_combined_diff, validate_hashes};
use crate::commands::read::parse_multi_file_diff_capped;
use crate::git::{git_cmd, repo_lock};
use crate::stack::guard::git_version;
use crate::types::{
    CombinedDiff, CombinedFallbackCommitDiff, CombinedFallbackFile, GitDiff, DIFF_TRUNCATE_BYTES,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::process::{Command, Output, Stdio};

/// Most blockers named per fallback file.
const MAX_BLOCKERS: usize = 5;

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
    /// The repository's toplevel: every command of the replay runs there,
    /// so `paths` (root-relative) and the names git prints agree.
    cwd: &'a str,
    /// The directory the caller opened: the key of the shared repo guard,
    /// as every other command takes it.
    lock: &'a str,
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
    fn pathspec(&self, cmd: &mut Command) {
        cmd.arg("--");
        if let Some(paths) = self.paths {
            cmd.args(paths);
        }
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    }

    fn in_paths(&self, path: &str) -> bool {
        match self.paths {
            None => true,
            Some(paths) => paths.iter().any(|q| covers(q, path)),
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
            "-c",
            "merge.default=text",
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
        // empty field. Only that part is checked: the messages are not read.
        let end = out
            .stdout
            .windows(2)
            .position(|w| w == b"\0\0")
            .unwrap_or(out.stdout.len());
        let stdout = utf8_names(&out.stdout[..end])?;
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
    /// truncation threshold, its file names checked against `touched`.
    fn diff(&self, a: &str, b: &str, unified0: bool) -> Result<Vec<GitDiff>, String> {
        let listed = self.touched(a, b)?;
        self.diff_listed(a, b, unified0, &listed)
    }

    /// [`Repo::diff`] when `listed` (the `touched(a, b)` of the same trees)
    /// is already known. The patch's file names come from a text parser; the
    /// `-z` listing is exact. Any name that differs is refused — a misread
    /// name would slip past the fallback filter, which matches by name, and
    /// show a wrong net diff.
    fn diff_listed(
        &self,
        a: &str,
        b: &str,
        unified0: bool,
        listed: &[(Option<String>, String)],
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
        self.pathspec(&mut cmd);
        let out = self.stdout(cmd, "diff-tree")?;
        let diffs = parse_multi_file_diff_capped(&out, Some(DIFF_TRUNCATE_BYTES));
        check_names(&diffs, listed)?;
        Ok(diffs)
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
        self.pathspec(&mut cmd);
        let out = self.output(cmd, "diff-tree")?;
        if !out.status.success() {
            return Err(format!(
                "git diff-tree failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let out = utf8_names(&out.stdout)?;
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

    /// Paths whose `merge` attribute names a driver (`union`, `binary`, a
    /// custom `merge.<name>.driver`, or `-merge`): `merge-tree` may resolve
    /// them with content that is not the net effect. Only `unspecified`,
    /// `set` and `text` (all three the built-in text merge) are trusted. Attributes are read as git
    /// reads them for this repository: worktree `.gitattributes` and
    /// `$GIT_DIR/info/attributes`.
    fn merge_driven(&self, paths: &[&str]) -> Result<HashSet<String>, String> {
        let mut out = HashSet::new();
        if paths.is_empty() {
            return Ok(out);
        }
        // Paths go through stdin (NUL-terminated): a large step can list more
        // paths than an argv holds.
        let mut cmd = self.git();
        cmd.args(["check-attr", "--stdin", "-z", "merge"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The only read of the worktree (`.gitattributes`): under the shared
        // repo guard so a checkout cannot rewrite it mid-read. Held for this
        // spawn only — the rest of the replay reads objects by id and runs
        // unlocked (see `git_combined_diff`).
        let _repo = repo_lock::read(self.lock);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to run git check-attr: {e}"))?;
        let input: Vec<u8> = paths
            .iter()
            .flat_map(|p| p.bytes().chain(std::iter::once(0)))
            .collect();
        let mut stdin = child.stdin.take().expect("stdin was piped");
        // Written on its own thread: git answers while it reads, so a large
        // input must not wait for stdout to be drained.
        let writer = std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(&input);
        });
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed to run git check-attr: {e}"))?;
        let _ = writer.join();
        if !output.status.success() {
            return Err(format!(
                "git check-attr failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        // `-z`: `<path>\0merge\0<value>\0` per path.
        let fields: Vec<&str> = stdout.split('\0').collect();
        for chunk in fields.chunks(3) {
            if let [path, _, value] = chunk {
                if !matches!(*value, "unspecified" | "set" | "text") {
                    out.insert(path.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Blockers of each of `paths` at one step: the commits outside the
    /// selection that touch it on either side between the replay base and
    /// `Ci^`, newest first, at most `MAX_BLOCKERS` — what `rev-list
    /// --full-history Ci^...<base> -- <path>` lists once the `selected`
    /// hashes are dropped. `Ci^ --not <base>`: changes `Ci` was written on
    /// that the replay lacks. `<base> --not Ci^`: changes the replay starts
    /// from that `Ci` never saw — with selected commits on two branches, an
    /// unselected commit under the oldest one is in the base and can be the
    /// cause. The ancestors of an earlier selected commit stay in the walk:
    /// their changes are not in the replayed tree, only the selected ones are. One `git log` walk per argv-sized pathspec batch, never
    /// one spawn per path. The walk is not bounded: with several paths, any
    /// `--max-count` could stop before an older blocker of a quieter path.
    /// `--full-history` keeps each path's answer independent of the other
    /// paths of its batch (default history simplification is not). A merge
    /// of the range is a blocker when it changed the path itself (its
    /// combined diff names it); the commits it brings in are walked too.
    fn blockers(
        &self,
        parent: &str,
        base: Option<&str>,
        selected: &HashSet<&str>,
        paths: &[String],
    ) -> Result<HashMap<String, Vec<String>>, String> {
        // A name `git log` prints is a path or under one: none starts with
        // the record marker unless a path does (see `parse_log_names`).
        if let Some(p) = paths.iter().find(|p| p.starts_with(LOG_RECORD_MARK)) {
            return Err(format!("Combined diffs do not support the file name: {p}"));
        }
        let mut found: HashMap<String, Vec<String>> = HashMap::new();
        let units: Vec<Vec<String>> = paths.iter().map(|p| vec![p.clone()]).collect();
        for batch in pathspec_batches(units, PATHSPEC_BATCH_BYTES) {
            let mut cmd = self.git();
            cmd.args([
                "-c",
                "log.follow=false",
                "log",
                "--no-color",
                "--no-show-signature",
                "--no-renames",
                "--no-relative",
                "--ignore-submodules=none",
                "--full-history",
                "--root",
                "--diff-merges=combined",
                "--name-only",
                "-z",
                "--format=%x00%x01%H",
            ]);
            // `Ci^...<base>`: the union of `Ci^ --not <base>` and
            // `<base> --not Ci^`, in one date-ordered walk (newest first).
            // Both object ids come from git (`rev-parse`), never from input.
            match base {
                Some(b) => cmd.arg(format!("{parent}...{b}")),
                None => cmd.arg(parent),
            };
            cmd.arg("--").args(&batch);
            cmd.env("GIT_LITERAL_PATHSPECS", "1");
            let commits = parse_log_names(&self.stdout(cmd, "log")?)?;
            for path in &batch {
                let list: Vec<String> = commits
                    .iter()
                    .filter(|(h, names)| {
                        !selected.contains(h.as_str()) && names.iter().any(|n| covers(path, n))
                    })
                    .take(MAX_BLOCKERS)
                    .map(|(h, _)| h.clone())
                    .collect();
                found.insert(path.clone(), list);
            }
        }
        Ok(found)
    }
}

/// Whether the literal pathspec `spec` matches `path`: the path itself or a
/// path under it.
fn covers(spec: &str, path: &str) -> bool {
    let spec = spec.trim_end_matches('/');
    path == spec || path.strip_prefix(spec).is_some_and(|r| r.starts_with('/'))
}

/// The byte after the NUL that opens each `git log` record
/// (`--format=%x00%x01%H`).
const LOG_RECORD_MARK: char = '\x01';

/// `git log --format=%x00%x01%H --name-only -z` → `(hash, names)` in walk
/// order. Each record opens with `\0\x01<hash>\0`; a commit's names follow
/// a `\n` (`\0\n<name>\0<name>\0…`), a merge's (`--diff-merges=combined`)
/// follow an empty field (`\0\0<name>\0…`). Records are split on
/// `\0\x01`: a name never starts with `\x01` (`blockers` refuses such a
/// path), so a name — even one of hex digits only — is never read as a hash.
fn parse_log_names(out: &str) -> Result<Vec<(String, Vec<String>)>, String> {
    let mut commits: Vec<(String, Vec<String>)> = Vec::new();
    let mut records = out.split("\0\x01");
    if records.next().is_some_and(|head| !head.is_empty()) {
        return Err("Unexpected git log output".to_string());
    }
    for record in records {
        let mut fields = record.split('\0');
        let hash = fields.next().unwrap_or("");
        if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("Unexpected git log output: {hash}"));
        }
        let mut names: Vec<String> = Vec::new();
        // A commit's first name carries the `\n` that ends its header; a
        // merge's first field is empty.
        if let Some(first) = fields.next() {
            if let Some(name) = first.strip_prefix('\n') {
                names.push(name.to_string());
            } else if !first.is_empty() {
                return Err(format!("Unexpected git log output: {first}"));
            }
        }
        names.extend(fields.filter(|f| !f.is_empty()).map(str::to_string));
        commits.push((hash.to_string(), names));
    }
    Ok(commits)
}

/// Most pathspec bytes (each name plus its NUL) per git command in the
/// per-commit fallback diffs. With the pinned `-c` flags, the subcommand
/// flags and two object ids, the whole argv stays under 8 KB, well below the
/// smallest platform limit (32 KB on Windows).
const PATHSPEC_BATCH_BYTES: usize = 7 * 1024;

/// Groups `units` (a name, or the two names of a rename) into batches of at
/// most `max` bytes, in order. A unit is never split; one larger than `max`
/// goes alone.
fn pathspec_batches(units: Vec<Vec<String>>, max: usize) -> Vec<Vec<String>> {
    let mut batches: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut size = 0;
    for unit in units {
        let n: usize = unit.iter().map(|p| p.len() + 1).sum();
        if !cur.is_empty() && size + n > max {
            batches.push(std::mem::take(&mut cur));
            size = 0;
        }
        size += n;
        cur.extend(unit);
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// A path in the fallback set.
#[derive(Clone, Default)]
struct Fb {
    /// Reported conflicted by `merge-tree`, or the other half of a rename
    /// pair with such a path.
    conflicted: bool,
    /// For a conflicted path: the replay step that reported the conflict and
    /// the path `merge-tree` named there (this one, or its rename partner).
    /// Blockers are computed from it once the replay is done, batched per
    /// step, and only for the paths shown.
    source: Option<(usize, String)>,
}

type FallbackSet = BTreeMap<String, Fb>;

/// Rename pairs with one side in the fallback bring the other side in, until
/// nothing changes. A conflicted side makes its partner conflicted too, with
/// the same blockers (the same `source`).
fn join_pairs(fallback: &mut FallbackSet, pairs: &[(String, String)]) {
    loop {
        let mut joined = false;
        for (a, b) in pairs {
            for (from, to) in [(a, b), (b, a)] {
                let Some(src) = fallback.get(from).cloned() else {
                    continue;
                };
                match fallback.get_mut(to) {
                    None => {
                        fallback.insert(to.clone(), src);
                        joined = true;
                    }
                    Some(dst) if src.conflicted && !dst.conflicted => {
                        *dst = src;
                        joined = true;
                    }
                    Some(_) => {}
                }
            }
        }
        if !joined {
            return;
        }
    }
}

/// Adds `path` as a companion (not conflicted, no blockers) unless present.
fn add_companion(fallback: &mut FallbackSet, path: String) {
    fallback.entry(path).or_default();
}

/// Every name of a file with a truncated entry, in the net diff or in any
/// step — a file being all the names its entries link by renames (union-find,
/// as `budget::apply_budget` groups step entries).
fn truncated_names(diffs: &[GitDiff], steps: &[Vec<GitDiff>]) -> HashSet<String> {
    let mut parent: BTreeMap<String, String> = BTreeMap::new();
    let all = || diffs.iter().chain(steps.iter().flatten());
    for d in all() {
        let a = root(&mut parent, &d.path);
        if let Some(old) = &d.old_path {
            let b = root(&mut parent, old);
            if a != b {
                parent.insert(b, a);
            }
        }
    }
    let seeds: HashSet<String> = all()
        .filter(|d| d.truncated_from_bytes.is_some())
        .map(|d| root(&mut parent, &d.path))
        .collect();
    if seeds.is_empty() {
        return HashSet::new();
    }
    let names: Vec<String> = parent.keys().cloned().collect();
    names
        .into_iter()
        .filter(|n| seeds.contains(&root(&mut parent, n)))
        .collect()
}

fn rename_pairs(diffs: &[GitDiff]) -> Vec<(String, String)> {
    diffs
        .iter()
        .filter_map(|d| d.old_path.clone().map(|o| (o, d.path.clone())))
        .collect()
}

fn touches(d: &GitDiff, set: &FallbackSet) -> bool {
    set.contains_key(&d.path) || d.old_path.as_ref().is_some_and(|p| set.contains_key(p))
}

/// `bytes` (NUL-separated file names, as `-z` prints them) as text. A name
/// that is not valid UTF-8 cannot be carried: decoded lossily it would match
/// nothing — not the patch's names, not the fallback — and vanish from both
/// views. The first such name is refused, its invalid bytes shown as `\xNN`.
fn utf8_names(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes).map_err(|_| {
        let name = bytes
            .split(|b| *b == 0)
            .find(|f| std::str::from_utf8(f).is_err())
            .unwrap_or(bytes);
        format!(
            "Combined diffs do not support the file name: {}",
            escape_invalid_utf8(name)
        )
    })
}

/// `bytes` with every byte outside a valid UTF-8 sequence written `\xNN`
/// (lowercase hex), the valid text kept as is.
fn escape_invalid_utf8(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        out.push_str(chunk.valid());
        for b in chunk.invalid() {
            out.push_str(&format!("\\x{b:02x}"));
        }
    }
    out
}

/// Every name the parsed patch carries (`path`, `old_path`) must be one the
/// exact `-z` listing of the same trees carries, and the other way round.
fn check_names(diffs: &[GitDiff], listed: &[(Option<String>, String)]) -> Result<(), String> {
    let parsed: BTreeSet<&str> = diffs
        .iter()
        .flat_map(|d| std::iter::once(d.path.as_str()).chain(d.old_path.as_deref()))
        .collect();
    let exact: BTreeSet<&str> = listed
        .iter()
        .flat_map(|(old, new)| {
            old.as_deref()
                .into_iter()
                .chain(std::iter::once(new.as_str()))
        })
        .collect();
    match parsed.symmetric_difference(&exact).min() {
        Some(name) => Err(format!(
            "Combined diffs do not support the file name: {name}"
        )),
        None => Ok(()),
    }
}

/// The working tree's toplevel of the repository `cwd` is in (`cwd` itself
/// for a repository opened at its root).
fn toplevel(cwd: &str) -> Result<String, String> {
    let out = git_cmd()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git rev-parse failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let top = stdout.strip_suffix('\n').unwrap_or(&stdout);
    if top.is_empty() {
        return Err("git rev-parse failed: no working tree".to_string());
    }
    Ok(top.to_string())
}

/// The combined diff of `hashes` (any order), optionally limited to `paths`
/// (repository-root-relative, as `git log` reports names), within the
/// production payload budget.
pub(crate) fn combined_diff(
    cwd: &str,
    hashes: &[String],
    paths: Option<&[String]>,
) -> Result<CombinedDiff, String> {
    combined_diff_with_budget(cwd, hashes, paths, COMBINED_BUDGET_BYTES)
}

/// [`combined_diff`] with an explicit payload budget. Only tests and the
/// parity probe pass anything but `COMBINED_BUDGET_BYTES`: the Tauri command
/// has no way to change it.
pub(crate) fn combined_diff_with_budget(
    cwd: &str,
    hashes: &[String],
    paths: Option<&[String]>,
    budget: usize,
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
    // Every command runs from the toplevel: `check-attr --stdin` reads its
    // paths relative to the cwd and pathspecs are cwd-relative, while the
    // names git prints (`--no-relative`) and `paths` are root-relative.
    let lock = cwd;
    let toplevel = toplevel(cwd)?;
    let cwd = toplevel.as_str();
    let commits = resolve_and_order(cwd, &hashes)?;
    let mut repo = Repo {
        cwd,
        lock,
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

    // 2. Replay, recording each step and growing the fallback set.
    let mut acc = base_tree.clone();
    let mut fallback: FallbackSet = BTreeMap::new();
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
        let step = repo.diff(&acc, &result, true)?;
        // What `Ci` itself changes. On the fast path it is the step diff.
        let ci_changes = if merged {
            repo.touched(&parent_tree, &c.tree)?
        } else {
            Vec::new()
        };
        // Rename pairs of this step: the step diff and `Ci` itself (the side
        // `merge-tree` followed). With a filter, also the pairs that cross it
        // (one name outside), once the fallback holds an out-of-filter path:
        // a conflicted path outside the filter can still pass its content —
        // conflict markers included — to an in-filter name.
        let mut pairs = rename_pairs(&step);
        pairs.extend(
            ci_changes
                .iter()
                .filter_map(|(old, new)| old.clone().map(|o| (o, new.clone()))),
        );
        let mut crossing = |fallback: &FallbackSet| -> Result<(), String> {
            if repo.paths.is_none() || !fallback.keys().any(|p| !repo.in_paths(p)) {
                return Ok(());
            }
            let whole = Repo {
                cwd,
                lock,
                paths: None,
                empty_tree: None,
            };
            let mut listed = whole.touched(&acc, &result)?;
            if merged {
                listed.extend(whole.touched(&parent_tree, &c.tree)?);
            }
            pairs.extend(
                listed
                    .into_iter()
                    .filter_map(|(old, new)| old.map(|o| (o, new)))
                    .filter(|(o, n)| repo.in_paths(o) != repo.in_paths(n)),
            );
            Ok(())
        };
        if let Some(conflicted) = conflicted {
            // (a) What `merge-tree` reports: conflicted, blockers computed
            //     later. Paths outside the filter are kept too (never shown):
            //     only their rename partners inside it matter.
            let direct = conflicted.iter().any(|p| repo.in_paths(p));
            for path in conflicted {
                if fallback.get(&path).is_some_and(|f| f.conflicted) {
                    continue;
                }
                let source = Some((i, path.clone()));
                fallback.insert(
                    path,
                    Fb {
                        conflicted: true,
                        source,
                    },
                );
            }
            crossing(&fallback)?;
            join_pairs(&mut fallback, &pairs);
            // (b), (c) Companions: `--name-only` misses paths a conflict
            // moves (`f` → `f~<oid>`), so everything this step and `Ci`
            // itself touch falls back too — only when the conflict reaches
            // the filter (a conflicted path in it, or the rename partner of
            // one): a conflict elsewhere cannot corrupt what is shown.
            let reaches = direct
                || fallback.iter().any(|(p, f)| {
                    f.conflicted && f.source.as_ref().is_some_and(|s| s.0 == i) && repo.in_paths(p)
                });
            if reaches {
                for d in &step {
                    add_companion(&mut fallback, d.path.clone());
                    if let Some(old) = &d.old_path {
                        add_companion(&mut fallback, old.clone());
                    }
                }
                for (old, new) in &ci_changes {
                    if let Some(old) = old {
                        add_companion(&mut fallback, old.clone());
                    }
                    add_companion(&mut fallback, new.clone());
                }
            }
        } else {
            crossing(&fallback)?;
        }
        if merged {
            // A merge is only trusted for the built-in text driver: `union`,
            // a custom driver… can succeed with content that is not the net
            // effect (`ours` even leaves the step diff silent, hence `Ci`'s
            // own paths). Every merged step, conflicted ones too: a conflict
            // outside the filter brings no companions, and a merge-driven
            // path inside it still merged "cleanly".
            let mut candidates: Vec<&str> = Vec::new();
            for d in &step {
                candidates.push(&d.path);
                candidates.extend(d.old_path.as_deref());
            }
            for (old, new) in &ci_changes {
                candidates.extend(old.as_deref());
                candidates.push(new);
            }
            candidates.retain(|p| !fallback.contains_key(*p));
            candidates.sort_unstable();
            candidates.dedup();
            for path in repo.merge_driven(&candidates)? {
                add_companion(&mut fallback, path);
            }
        }
        // After every step, clean ones included: a rename that moves a
        // fallback path carries its content (conflict markers included) to
        // the new path, which must join the fallback.
        if !fallback.is_empty() {
            join_pairs(&mut fallback, &pairs);
        }
        steps.push(step);
        acc = result;
    }

    // 3. Net diff. A rename pair touching the fallback goes there whole —
    //    with a filter, a pair crossing it too (see the replay). Then only
    //    the fallback paths inside the filter remain.
    let mut diffs = repo.diff(&base_tree, &acc, false)?;
    let mut pairs = rename_pairs(&diffs);
    if repo.paths.is_some() && fallback.keys().any(|p| !repo.in_paths(p)) {
        let whole = Repo {
            cwd,
            lock,
            paths: None,
            empty_tree: None,
        };
        pairs.extend(
            whole
                .touched(&base_tree, &acc)?
                .into_iter()
                .filter_map(|(old, new)| old.map(|o| (o, new)))
                .filter(|(o, n)| repo.in_paths(o) != repo.in_paths(n)),
        );
    }
    join_pairs(&mut fallback, &pairs);
    fallback.retain(|p, _| repo.in_paths(p));
    diffs.retain(|d| !touches(d, &fallback));

    // Blockers of the conflicted paths shown: one batched walk per step.
    let mut sources: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for fb in fallback.values() {
        if let Some((i, path)) = &fb.source {
            sources.entry(*i).or_default().insert(path.clone());
        }
    }
    let mut blockers: HashMap<(usize, String), Vec<String>> = HashMap::new();
    let chosen: HashSet<&str> = replayed.iter().map(|r| r.hash.as_str()).collect();
    for (i, paths) in sources {
        let Some(parent) = &replayed[i].parent else {
            continue;
        };
        let paths: Vec<String> = paths.into_iter().collect();
        for (path, list) in repo.blockers(parent, base.as_deref(), &chosen, &paths)? {
            blockers.insert((i, path), list);
        }
    }

    // 5. Steps: no fallback file, and no file with a truncated net diff or a
    //    truncated entry in any step: its attribution would be partial. A
    //    file is every name its entries link by renames (as the budget
    //    groups them), so a truncated step under an earlier name drops the
    //    later names' steps too.
    let truncated = truncated_names(&diffs, &steps);
    let steps: Vec<Vec<GitDiff>> = steps
        .into_iter()
        .map(|step| {
            step.into_iter()
                .filter(|d| {
                    !touches(d, &fallback)
                        && !truncated.contains(&d.path)
                        && !d.old_path.as_ref().is_some_and(|p| truncated.contains(p))
                })
                .collect()
        })
        .collect();

    // 4. Per-commit diffs of the fallback files, in replay order. A rename
    //    entry belongs to its new path; to its old one only when the new path
    //    is not itself in fallback. Only the fallback's names are diffed —
    //    never the whole commit, which can be huge — given as pathspecs in
    //    batches small enough for any argv (the fallback can hold thousands
    //    of paths; Windows caps a command line at 32 KB). A rename's two
    //    names share a batch so `-M` still pairs them.
    let mut per_path: BTreeMap<String, Vec<CombinedFallbackCommitDiff>> = BTreeMap::new();
    if !fallback.is_empty() {
        let whole = Repo {
            cwd,
            lock,
            paths: None,
            empty_tree: repo.empty_tree.clone(),
        };
        for c in &replayed {
            let parent_tree = match &c.parent_tree {
                Some(t) => t.clone(),
                None => repo.empty_tree()?,
            };
            // Names only (`-z`), cheap even for a huge commit.
            let listed = whole.touched(&parent_tree, &c.tree)?;
            let units: Vec<Vec<String>> = listed
                .into_iter()
                .filter(|(old, new)| {
                    fallback.contains_key(new)
                        || old.as_ref().is_some_and(|o| fallback.contains_key(o))
                })
                .map(|(old, new)| old.into_iter().chain(std::iter::once(new)).collect())
                .collect();
            for batch in pathspec_batches(units, PATHSPEC_BATCH_BYTES) {
                let part = Repo {
                    cwd,
                    lock,
                    paths: Some(&batch),
                    empty_tree: None,
                };
                // `diff` re-lists the batch with `-z`: the name cross-check
                // runs per batch.
                for d in part.diff(&parent_tree, &c.tree, false)? {
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
    }
    // Fallback paths no selected commit touches are conflict artefacts.
    let mut fallback: Vec<CombinedFallbackFile> = fallback
        .into_iter()
        .filter_map(|(path, fb)| {
            let per_commit = per_path.remove(&path)?;
            let blockers = fb
                .source
                .and_then(|s| blockers.get(&s).cloned())
                .unwrap_or_default();
            Some(CombinedFallbackFile {
                path,
                conflicted: fb.conflicted,
                per_commit,
                blockers,
            })
        })
        .collect();

    // 6. Total payload budget: steps first, then header-only entries.
    let mut steps = steps;
    let cut = apply_budget(&mut diffs, &mut steps, &mut fallback, budget);

    Ok(CombinedDiff {
        base,
        commits,
        diffs,
        steps,
        fallback,
        truncated: cut.truncated,
        budget_omitted: cut.omitted,
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

    /// A blocker before an earlier selected commit still counts: B1's change
    /// to `p` is not in the replayed tree (only C1 and C2 are), so C3's
    /// conflict on `p` names B1 — never "between selected commits".
    #[test]
    fn blocker_behind_an_earlier_selected_commit_is_named() {
        let r = TempRepo::new();
        commit_files(&r, &[("p", Some("a\nx=1\nc\n"))], "base");
        let c1 = commit_files(&r, &[("p", Some("a\nx=2\nc\n"))], "C1");
        let b1 = commit_files(&r, &[("p", Some("a\nx=3\nc\n"))], "B1");
        let c2 = commit_files(&r, &[("q", Some("q\n"))], "C2");
        commit_files(&r, &[("o", Some("o\n"))], "B2");
        let c3 = commit_files(&r, &[("p", Some("a\nx=4\nc\ne\n"))], "C3");
        let got = run(&r, &[&c1, &c2, &c3], None);
        let f = got.fallback.iter().find(|f| f.path == "p").unwrap();
        assert!(f.conflicted);
        assert_eq!(f.blockers, vec![b1]);
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

    /// One commit from `(path, content)` pairs at a fixed date (unix
    /// seconds, author and committer alike).
    fn commit_files_at(r: &TempRepo, files: &[(&str, Option<&str>)], msg: &str, ts: i64) -> String {
        for (path, content) in files {
            match content {
                Some(c) => r.write(path, c),
                None => std::fs::remove_file(r.path.join(path)).unwrap(),
            }
        }
        r.git(&["add", "-A"]);
        let date = format!("{ts} +0000");
        let out = std::process::Command::new(crate::git::git_binary())
            .args(["commit", "-q", "-m", msg])
            .env("GIT_COMMITTER_DATE", &date)
            .env("GIT_AUTHOR_DATE", &date)
            .current_dir(&r.path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        r.git(&["rev-parse", "HEAD"])
    }

    /// Selected commits on two branches: the replay base is the parent of
    /// the oldest one (Y^ = U), already holding U's change to `f`. X's
    /// conflict on `f` comes from U, an unselected commit that is in the
    /// base but not under X^ — it is named, never "between selected commits".
    #[test]
    fn blocker_already_in_the_replay_base_is_named() {
        let r = TempRepo::new();
        commit_files_at(&r, &[("f", Some("x=1\n"))], "M", 1_000_000_000);
        r.git(&["checkout", "-q", "-b", "b2"]);
        let u = commit_files_at(&r, &[("f", Some("x=2\n"))], "U", 1_000_001_000);
        let y = commit_files_at(&r, &[("g", Some("g\n"))], "Y", 1_000_002_000);
        r.git(&["checkout", "-q", "main"]);
        r.git(&["checkout", "-q", "-b", "b1"]);
        let x = commit_files_at(&r, &[("f", Some("x=3\n"))], "X", 1_000_003_000);
        let got = run(&r, &[&x, &y], None);
        assert_eq!(got.base, Some(u.clone()));
        let f = got.fallback.iter().find(|f| f.path == "f").unwrap();
        assert!(f.conflicted);
        assert_eq!(f.blockers, vec![u]);
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

    /// The review's case: a conflict on `README` (outside the filter) must
    /// not send the in-filter `X`, which merges cleanly, to the fallback.
    #[test]
    fn out_of_filter_conflict_leaves_in_filter_files_net() {
        let r = TempRepo::new();
        commit_files(
            &r,
            &[("X", Some(&ten("l"))), ("README", Some("a\nx=1\nc\n"))],
            "base",
        );
        let x1 = ten("l").replacen("l1\n", "A1\n", 1);
        let a = commit_files(
            &r,
            &[("X", Some(&x1)), ("README", Some("a\nx=2\nc\n"))],
            "A",
        );
        commit_files(&r, &[("README", Some("a\nx=3\nc\n"))], "B");
        let c = commit_files(
            &r,
            &[
                ("X", Some(&x1.replacen("l10\n", "C10\n", 1))),
                ("README", Some("a\nx=4\nc\n")),
            ],
            "C",
        );
        let got = run(&r, &[&a, &c], Some(&["X"]));
        assert_eq!(paths_of(&got.diffs), vec!["X"]);
        assert_eq!(lines(&got.diffs[0], "add"), vec!["A1", "C10"]);
        assert!(got.fallback.is_empty(), "{:?}", got.fallback);
        assert_eq!(paths_of(&got.steps[1]), vec!["X"]);
        // Unfiltered, `README` conflicts and `X` is its companion.
        let all = run(&r, &[&a, &c], None);
        let fb: Vec<&str> = all.fallback.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(fb, vec!["README", "X"]);
    }

    /// A step whose only conflict is a path already conflicted earlier still
    /// sends its companions to the fallback.
    #[test]
    fn a_repeat_conflict_still_brings_companions() {
        let r = TempRepo::new();
        let f = |x: u32, y: u32| format!("a\nx={x}\nb\nc\nd\ne\ny={y}\nz\n");
        commit_files(&r, &[("f", Some(&f(1, 1)))], "base");
        let a = commit_files(&r, &[("f", Some(&f(2, 1)))], "A");
        commit_files(&r, &[("f", Some(&f(3, 1)))], "B");
        let c = commit_files(&r, &[("f", Some(&f(4, 1)))], "C");
        commit_files(&r, &[("f", Some(&f(4, 2)))], "D");
        let e = commit_files(&r, &[("f", Some(&f(4, 3))), ("g", Some("g\n"))], "E");
        let got = run(&r, &[&a, &c, &e], None);
        let fb: Vec<&str> = got.fallback.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(fb, vec!["f", "g"]);
        assert!(got.diffs.is_empty(), "{:?}", paths_of(&got.diffs));
    }

    /// An out-of-filter conflicted path that a later selected commit renames
    /// into the filter carries its conflict markers there: the in-filter name
    /// falls back, conflicted, with the blocker of the conflict.
    #[test]
    fn out_of_filter_conflict_renamed_into_the_filter_falls_back() {
        let r = TempRepo::new();
        commit_files(
            &r,
            &[("README", Some(&ten("l"))), ("g", Some("g\n"))],
            "base",
        );
        let a = commit_files(
            &r,
            &[("README", Some(&ten("l").replacen("l5\n", "A\n", 1)))],
            "A",
        );
        let b = commit_files(
            &r,
            &[("README", Some(&ten("l").replacen("l5\n", "B\n", 1)))],
            "B",
        );
        let c = commit_files(
            &r,
            &[("README", Some(&ten("l").replacen("l5\n", "C\n", 1)))],
            "C",
        );
        r.git(&["mv", "README", "X"]);
        r.git(&["commit", "-q", "-m", "D"]);
        let d = r.git(&["rev-parse", "HEAD"]);
        let got = run(&r, &[&a, &c, &d], Some(&["X"]));
        for e in got.diffs.iter().chain(got.steps.iter().flatten()) {
            assert_ne!(e.path, "X", "X leaks: {e:?}");
        }
        let fb: Vec<&str> = got.fallback.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(fb, vec!["X"]);
        assert!(got.fallback[0].conflicted);
        assert_eq!(got.fallback[0].blockers, vec![b]);
        assert!(got.fallback[0].per_commit.iter().any(|p| p.hash == d));
    }

    /// Blockers come from one batched walk per step; per path they are what
    /// `rev-list --max-count 5 Ci^ --not <base> <earlier> -- <path>` lists,
    /// newest first.
    #[test]
    fn batched_blockers_match_the_per_path_query() {
        let r = TempRepo::new();
        let v = |n: u32| format!("a\nx={n}\nc\n");
        commit_files(&r, &[("p", Some(&v(1))), ("q", Some(&v(1)))], "base");
        let a = commit_files(&r, &[("p", Some(&v(2))), ("q", Some(&v(2)))], "A");
        commit_files(&r, &[("p", Some(&v(3)))], "U1");
        commit_files(&r, &[("q", Some(&v(3)))], "U2");
        commit_files(&r, &[("p", Some(&v(4))), ("q", Some(&v(4)))], "U3");
        for n in 5..10 {
            commit_files(&r, &[("p", Some(&v(n)))], &format!("U{n}"));
        }
        commit_files(&r, &[("other", Some("o\n"))], "U10");
        let c = commit_files(
            &r,
            &[
                ("p", Some("a\nx=10\nc\ne\n")),
                ("q", Some("a\nx=10\nc\ne\n")),
            ],
            "C",
        );
        let got = run(&r, &[&a, &c], None);
        let per_path = |path: &str| -> Vec<String> {
            r.git(&[
                "rev-list",
                "--max-count",
                "5",
                &format!("{c}^"),
                "--not",
                &format!("{a}^"),
                &a,
                "--",
                path,
            ])
            .lines()
            .map(str::to_string)
            .collect()
        };
        let fb = |path: &str| got.fallback.iter().find(|f| f.path == path).unwrap();
        assert_eq!(fb("p").blockers, per_path("p"));
        assert_eq!(fb("p").blockers.len(), 5);
        assert_eq!(fb("q").blockers, per_path("q"));
        assert_eq!(fb("q").blockers.len(), 2);
    }

    /// The `git log -z --name-only --format=%x00%x01%H` stream as git 2.5x
    /// writes it: a commit's names follow `\0\n`, a merge's follow `\0\0`
    /// (no newline); names may be all hex digits or start with a newline.
    #[test]
    fn parse_log_names_reads_records() {
        let out = concat!(
            "\0\x01f7\0\n\nweird\0b\0\0",
            "\0\x01bb\0\0cafe\0\nnl\0\0",
            "\0\x01aa\0\0",
            "\0\x0178\0\nb\0\0",
            "\0\x01b7\0\nf\0a\0",
        );
        let got = parse_log_names(out).unwrap();
        let want: Vec<(String, Vec<String>)> = vec![
            ("f7".into(), vec!["\nweird".into(), "b".into()]),
            ("bb".into(), vec!["cafe".into(), "\nnl".into()]),
            ("aa".into(), vec![]),
            ("78".into(), vec!["b".into()]),
            ("b7".into(), vec!["f".into(), "a".into()]),
        ];
        assert_eq!(got, want);
        assert!(parse_log_names("\0\x01not-a-hash\0").is_err());
        assert!(parse_log_names("junk\0\x01ab\0").is_err());
        assert_eq!(parse_log_names("").unwrap(), vec![]);
    }

    /// A path starting with the record marker byte could pass for a record:
    /// refused before any walk.
    #[test]
    fn blockers_refuse_a_path_starting_with_the_marker() {
        let r = TempRepo::new();
        let head = r.git(&["rev-parse", "HEAD"]);
        let repo = Repo {
            cwd: &cwd(&r),
            lock: &cwd(&r),
            paths: None,
            empty_tree: None,
        };
        let err = repo
            .blockers(
                &head,
                None,
                &HashSet::new(),
                &["ok".to_string(), "\x01x".to_string()],
            )
            .unwrap_err();
        assert_eq!(err, "Combined diffs do not support the file name: \x01x");
    }

    /// Conflicts on more path bytes than one argv batch: every path still
    /// gets its blocker, through several batched walks.
    #[test]
    fn blockers_of_many_conflicts_span_batches() {
        let r = TempRepo::new();
        let names: Vec<String> = (0..40)
            .map(|i| format!("dir/{i:03}{}", "n".repeat(250)))
            .collect();
        let set = |v: &'static str| -> Vec<(&str, Option<&str>)> {
            names.iter().map(|n| (n.as_str(), Some(v))).collect()
        };
        commit_files(&r, &set("a\nx=1\nc\n"), "base");
        let a = commit_files(&r, &set("a\nx=2\nc\n"), "A");
        let b = commit_files(&r, &set("a\nx=3\nc\n"), "B");
        let c = commit_files(&r, &set("a\nx=4\nc\n"), "C");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(got.fallback.len(), names.len());
        for f in &got.fallback {
            assert!(f.conflicted);
            assert_eq!(f.blockers, vec![b.clone()], "{}", f.path);
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
            ("merge.default", "union"),
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

    /// Only the path `merge-tree` reported is `conflicted` (with blockers); a
    /// companion pulled in because `Ci` also touches it is not.
    #[test]
    fn conflicted_flag_and_blockers_only_on_real_conflicts() {
        let r = TempRepo::new();
        commit_files(&r, &[("f", Some("a\nx=1\nc\n"))], "base");
        let a = commit_files(&r, &[("f", Some("a\nx=2\nc\n"))], "A");
        let b = commit_files(&r, &[("f", Some("a\nx=3\nc\n"))], "B");
        let c = commit_files(
            &r,
            &[("f", Some("a\nx=4\nc\ne\n")), ("g", Some("g\n"))],
            "C",
        );
        let got = run(&r, &[&a, &c], None);
        let f = got.fallback.iter().find(|x| x.path == "f").unwrap();
        assert!(f.conflicted);
        assert_eq!(f.blockers, vec![b]);
        let g = got.fallback.iter().find(|x| x.path == "g").unwrap();
        assert!(!g.conflicted);
        assert!(g.blockers.is_empty());
        assert_eq!(g.per_commit.len(), 1);
    }

    /// A file with any truncated step entry loses all its step entries: no
    /// partial attribution.
    #[test]
    fn truncated_step_drops_every_step_of_that_file() {
        let r = TempRepo::new();
        let big: String = (0..700_000).map(|i| format!("line {i}\n")).collect();
        let a = commit_files(&r, &[("big.txt", Some(&big))], "A");
        let edited = big.replacen("line 5\n", "five\n", 1);
        let c = commit_files(&r, &[("big.txt", Some(&edited))], "C");
        let d = commit_files(&r, &[("big.txt", None), ("t.txt", Some("t\n"))], "D");
        let got = run(&r, &[&a, &c, &d], None);
        assert!(got.diffs.iter().all(|e| e.path != "big.txt"));
        assert!(got.steps.iter().flatten().all(|e| e.path != "big.txt"));
        assert_eq!(paths_of(&got.steps[2]), vec!["t.txt"]);
    }

    /// A truncated step under an earlier name drops the later names too: A
    /// adds a > 5 MB block to `p` (truncated), B renames `p` → `q`, C and D
    /// each remove half of it (under the cap). The net diff is a small
    /// `p` → `q` rename; `q`'s steps alone would attribute against an
    /// intermediate file.
    #[test]
    fn truncated_step_drops_every_name_of_a_renamed_file() {
        let r = TempRepo::new();
        let head: String = (0..20).map(|i| format!("keep {i}\n")).collect();
        commit_files(&r, &[("p", Some(&head)), ("g", Some("g\n"))], "base");
        let half1: String = (0..175_000).map(|i| format!("block one {i}\n")).collect();
        let half2: String = (0..175_000).map(|i| format!("block two {i}\n")).collect();
        assert!(half1.len() + half2.len() > crate::types::DIFF_TRUNCATE_BYTES);
        // Each half's `-U0` section (one `+`/`-` per line) stays under the cap.
        assert!(half2.len() + 175_000 < crate::types::DIFF_TRUNCATE_BYTES);
        let a = commit_files(&r, &[("p", Some(&format!("{head}{half1}{half2}")))], "A");
        r.git(&["mv", "p", "q"]);
        r.git(&["commit", "-q", "-m", "B"]);
        let b = r.git(&["rev-parse", "HEAD"]);
        let c = commit_files(&r, &[("q", Some(&format!("{head}{half2}")))], "C");
        let d = commit_files(&r, &[("q", Some(&format!("{head}end\n")))], "D");
        let got = run(&r, &[&a, &b, &c, &d], None);
        let net = got.diffs.iter().find(|e| e.path == "q").unwrap();
        assert_eq!(net.old_path.as_deref(), Some("p"));
        assert!(net.truncated_from_bytes.is_none());
        assert!(
            got.steps
                .iter()
                .flatten()
                .all(|e| e.path != "p" && e.path != "q"),
            "{:?}",
            got.steps.iter().map(|s| paths_of(s)).collect::<Vec<_>>()
        );
    }

    /// Repo where `f` carries the `merge` attribute `driver`; B (unselected)
    /// and C edit the same line of `f`; A edits `g`. Returns (A, C).
    fn merge_driver_repo(r: &TempRepo, driver: &str) -> (String, String) {
        commit_files(
            r,
            &[
                (".gitattributes", Some(&format!("f merge={driver}\n"))),
                ("f", Some("a\nx=1\nc\n")),
                ("g", Some("g\n")),
            ],
            "base",
        );
        let a = commit_files(r, &[("g", Some("g2\n"))], "A");
        let _b = commit_files(r, &[("f", Some("a\nx=2\nc\n"))], "B");
        let c = commit_files(r, &[("f", Some("a\nx=3\nc\n"))], "C");
        (a, c)
    }

    /// `merge=union` makes `merge-tree` succeed with both sides' lines: not
    /// the net effect, so `f` falls back.
    #[test]
    fn union_merge_attribute_falls_back() {
        let r = TempRepo::new();
        let (a, c) = merge_driver_repo(&r, "union");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(paths_of(&got.diffs), vec!["g"]);
        let fb: Vec<&str> = got.fallback.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(fb, vec!["f"]);
        assert!(!got.fallback[0].conflicted);
        assert!(got.steps.iter().flatten().all(|e| e.path != "f"));
    }

    /// A custom driver that keeps "ours" drops C's edit from the merge: the
    /// step diff never mentions `f`, only C's own diff does.
    #[test]
    fn custom_merge_driver_falls_back() {
        let r = TempRepo::new();
        r.git(&["config", "merge.keep.driver", "true"]);
        let (a, c) = merge_driver_repo(&r, "keep");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(paths_of(&got.diffs), vec!["g"]);
        let fb: Vec<&str> = got.fallback.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(fb, vec!["f"]);
    }

    /// `merge=text` names the built-in text merge: a clean merge of such a
    /// path is trusted like an unspecified one and stays in the net view.
    #[test]
    fn text_merge_attribute_is_trusted() {
        let r = TempRepo::new();
        commit_files(
            &r,
            &[
                (".gitattributes", Some("f merge=text\n")),
                ("f", Some(&ten("l"))),
                ("g", Some("g\n")),
            ],
            "base",
        );
        let f1 = ten("l").replacen("l1\n", "A1\n", 1);
        let a = commit_files(&r, &[("f", Some(&f1))], "A");
        commit_files(&r, &[("g", Some("g2\n"))], "B");
        let c = commit_files(&r, &[("f", Some(&f1.replacen("l10\n", "C10\n", 1)))], "C");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(paths_of(&got.diffs), vec!["f"]);
        assert!(got.fallback.is_empty());
        assert_eq!(paths_of(&got.steps[1]), vec!["f"]);
    }

    /// A repository opened from a subdirectory: every git command runs from
    /// the toplevel, `paths` are root-relative (as the file log reports
    /// them), and `/sub/x.txt merge=union` in the root `.gitattributes`
    /// applies — the result is the one of the toplevel.
    #[test]
    fn subdirectory_cwd_reads_from_the_toplevel() {
        let r = TempRepo::new();
        commit_files(
            &r,
            &[
                (".gitattributes", Some("/sub/x.txt merge=union\n")),
                ("sub/x.txt", Some("a\nx=1\nc\n")),
                ("sub/g", Some("g\n")),
            ],
            "base",
        );
        let a = commit_files(&r, &[("sub/g", Some("g2\n"))], "A");
        commit_files(&r, &[("sub/x.txt", Some("a\nx=2\nc\n"))], "B");
        let c = commit_files(&r, &[("sub/x.txt", Some("a\nx=3\nc\n"))], "C");
        let sub = r.path.join("sub").to_string_lossy().to_string();
        let hashes = vec![a.clone(), c.clone()];
        let from_root = run(&r, &[&a, &c], None);
        assert_eq!(paths_of(&from_root.diffs), vec!["sub/g"]);
        let fb: Vec<&str> = from_root.fallback.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(fb, vec!["sub/x.txt"]);
        assert_eq!(combined_diff(&sub, &hashes, None).unwrap(), from_root);
        let filter = vec!["sub/x.txt".to_string()];
        let filtered_root = combined_diff(&cwd(&r), &hashes, Some(&filter)).unwrap();
        let fb: Vec<&str> = filtered_root
            .fallback
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(fb, vec!["sub/x.txt"]);
        assert_eq!(
            combined_diff(&sub, &hashes, Some(&filter)).unwrap(),
            filtered_root
        );
    }

    /// The review's case: with a filter, a step whose only conflict is
    /// outside it still goes through the merge-driver check — `x.txt`
    /// (`merge=union`, inside the filter) merges "cleanly" there with both
    /// sides' lines, which is not the net effect.
    #[test]
    fn union_in_filter_falls_back_when_the_step_conflicts_outside_it() {
        let r = TempRepo::new();
        commit_files(
            &r,
            &[
                (".gitattributes", Some("x.txt merge=union\n")),
                ("x.txt", Some("a\nx=1\nc\n")),
                ("other", Some("a\nx=1\nc\n")),
            ],
            "base",
        );
        let a = commit_files(&r, &[("other", Some("a\nx=2\nc\n"))], "A");
        commit_files(
            &r,
            &[
                ("x.txt", Some("a\nx=2\nc\n")),
                ("other", Some("a\nx=3\nc\n")),
            ],
            "B",
        );
        let c = commit_files(
            &r,
            &[
                ("x.txt", Some("a\nx=3\nc\n")),
                ("other", Some("a\nx=4\nc\n")),
            ],
            "C",
        );
        let got = run(&r, &[&a, &c], Some(&["x.txt"]));
        assert!(got.diffs.is_empty(), "net: {:?}", got.diffs);
        let fb: Vec<(&str, bool)> = got
            .fallback
            .iter()
            .map(|f| (f.path.as_str(), f.conflicted))
            .collect();
        assert_eq!(fb, vec![("x.txt", false)]);
        assert!(got.steps.iter().flatten().all(|e| e.path != "x.txt"));
    }

    /// Blockers through a merge in the walked range: the merge (it changed
    /// the files itself) and the side commit are both listed, for a plain
    /// name and for names that are all hex digits — never read as a hash.
    #[test]
    fn blockers_through_a_merge_in_the_range() {
        let r = TempRepo::new();
        let names = ["notes.txt", "cafe", "f"];
        let set = |content: &'static str| -> Vec<(&str, Option<&str>)> {
            names.iter().map(|n| (*n, Some(content))).collect()
        };
        commit_files(&r, &set("a\nx=1\nc\n"), "base");
        let a = commit_files(&r, &set("a\nx=2\nc\n"), "A");
        r.git(&["checkout", "-q", "-b", "side"]);
        commit_files(&r, &set("a\nx=3\nc\n"), "S");
        r.git(&["checkout", "-q", "main"]);
        commit_files(&r, &[("g", Some("g\n"))], "M1");
        // Resolve as a third content: the merge itself changes the files.
        let _ = std::process::Command::new(crate::git::git_binary())
            .args(["merge", "-q", "--no-ff", "--no-commit", "side"])
            .current_dir(&r.path)
            .output()
            .unwrap();
        commit_files(&r, &set("a\nx=7\nc\n"), "M");
        let c = commit_files(&r, &set("a\nx=8\nc\ne\n"), "C");
        let got = run(&r, &[&a, &c], None);
        let per_path = |path: &str| -> Vec<String> {
            r.git(&[
                "rev-list",
                "--full-history",
                "--max-count",
                "5",
                &format!("{c}^"),
                "--not",
                &format!("{a}^"),
                &a,
                "--",
                path,
            ])
            .lines()
            .map(str::to_string)
            .collect()
        };
        for n in names {
            let f = got.fallback.iter().find(|f| f.path == n).unwrap();
            assert!(f.conflicted, "{n}");
            assert_eq!(f.blockers.len(), 2, "{n}: {:?}", f.blockers);
            assert_eq!(f.blockers, per_path(n), "{n}");
        }
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
        // The per-file cap, not the payload budget: not listed as omitted.
        assert!(!got.truncated);
        assert!(got.budget_omitted.is_empty());
        assert!(got.steps.iter().flatten().all(|d| d.path != "big.txt"));
        let t = got.diffs.iter().find(|d| d.path == "t.txt").unwrap();
        assert!(t.truncated_from_bytes.is_none());
    }

    /// The payload weight, as the budget counts it.
    fn weight(c: &CombinedDiff) -> usize {
        let w = super::super::budget::weight;
        c.diffs.iter().map(w).sum::<usize>()
            + c.steps.iter().flatten().map(w).sum::<usize>()
            + c.fallback
                .iter()
                .flat_map(|f| f.per_commit.iter())
                .map(|p| w(&p.diff))
                .sum::<usize>()
    }

    /// The total budget: under it nothing changes; just over it the largest
    /// file loses its steps only; at zero every step goes and every entry
    /// becomes header-only.
    #[test]
    fn payload_budget_cuts_steps_then_entries() {
        let r = TempRepo::new();
        commit_files(&r, &[("keep", Some("k\n"))], "base");
        let a = commit_files(&r, &[("small.txt", Some("s\n"))], "A");
        commit_files(&r, &[("keep", Some("k2\n"))], "B");
        let c = commit_files(&r, &[("large.txt", Some(&ten("large line ")))], "C");
        let hashes = vec![a.clone(), c.clone()];
        let full = combined_diff_with_budget(&cwd(&r), &hashes, None, usize::MAX).unwrap();
        assert!(!full.truncated);
        let total = weight(&full);
        let same = combined_diff_with_budget(&cwd(&r), &hashes, None, total).unwrap();
        assert_eq!(same, full);

        let cut = combined_diff_with_budget(&cwd(&r), &hashes, None, total - 1).unwrap();
        assert!(cut.truncated);
        assert!(cut.budget_omitted.is_empty());
        assert_eq!(cut.diffs, full.diffs);
        assert_eq!(paths_of(&cut.steps.concat()), vec!["small.txt"]);

        let zero = combined_diff_with_budget(&cwd(&r), &hashes, None, 0).unwrap();
        assert!(zero.truncated);
        assert!(zero.steps.iter().all(|s| s.is_empty()));
        assert_eq!(paths_of(&zero.diffs), vec!["large.txt", "small.txt"]);
        let omitted: Vec<(&str, Option<&str>)> = zero
            .budget_omitted
            .iter()
            .map(|o| (o.path.as_str(), o.commit.as_deref()))
            .collect();
        assert_eq!(omitted, vec![("large.txt", None), ("small.txt", None)]);
        for d in &zero.diffs {
            assert!(d.hunks.is_empty());
            assert!(d.truncated_from_bytes.unwrap() > 0);
        }
        // Production uses the 16 MB constant.
        assert!(!run(&r, &[&a, &c], None).truncated);
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

    /// Names a split on ` b/` misreads, and names git C-quotes.
    #[cfg(unix)]
    const ODD_NAMES: [&str; 5] = [
        "plan b/f.txt",
        "we\"ird.txt",
        "ta\tb.txt",
        "back\\slash.txt",
        "é.txt",
    ];

    /// The review's case: A `1→2`, B `2→3` (unselected), C deletes the file.
    /// Every odd name falls back under its real name, with its blocker — none
    /// shows up in the net view, under any name.
    #[cfg(unix)]
    #[test]
    fn odd_names_fall_back_by_their_real_name() {
        let r = TempRepo::new();
        let set = |content: Option<&'static str>| -> Vec<(&str, Option<&str>)> {
            ODD_NAMES.iter().map(|f| (*f, content)).collect()
        };
        commit_files(&r, &set(Some("1\n")), "base");
        let a = commit_files(&r, &set(Some("2\n")), "A");
        let b = commit_files(&r, &set(Some("3\n")), "B");
        let c = commit_files(&r, &set(None), "C");
        let got = run(&r, &[&a, &c], None);
        assert!(got.diffs.is_empty(), "net: {:?}", paths_of(&got.diffs));
        let mut fallback: Vec<&str> = got.fallback.iter().map(|f| f.path.as_str()).collect();
        fallback.sort_unstable();
        let mut want = ODD_NAMES.to_vec();
        want.sort_unstable();
        assert_eq!(fallback, want);
        for f in &got.fallback {
            assert!(f.conflicted, "{}", f.path);
            assert_eq!(f.blockers, vec![b.clone()], "{}", f.path);
            let per: Vec<&str> = f.per_commit.iter().map(|p| p.hash.as_str()).collect();
            assert_eq!(per, vec![a.as_str(), c.as_str()], "{}", f.path);
            assert!(f.per_commit.iter().all(|p| p.diff.path == f.path));
        }
    }

    /// A clean non-contiguous replay keeps every odd name in the net view,
    /// under its real name, with its steps.
    #[cfg(unix)]
    #[test]
    fn odd_names_replay_cleanly() {
        let r = TempRepo::new();
        let set = |content: &str| -> Vec<(String, String)> {
            ODD_NAMES
                .iter()
                .map(|f| (f.to_string(), content.to_string()))
                .collect()
        };
        let commit = |files: Vec<(String, String)>, msg: &str| {
            let files: Vec<(&str, Option<&str>)> = files
                .iter()
                .map(|(p, c)| (p.as_str(), Some(c.as_str())))
                .collect();
            commit_files(&r, &files, msg)
        };
        let f1 = ten("l").replacen("l1\n", "A1\n", 1);
        commit(set(&ten("l")), "base");
        let a = commit(set(&f1), "A");
        commit_files(&r, &[("other", Some("o\n"))], "B");
        let c = commit(set(&f1.replacen("l10\n", "C10\n", 1)), "C");
        let got = run(&r, &[&a, &c], None);
        let mut want: Vec<String> = ODD_NAMES.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(paths_of(&got.diffs), want);
        assert!(got.fallback.is_empty());
        for d in &got.diffs {
            assert_eq!(lines(d, "add"), vec!["A1", "C10"], "{}", d.path);
        }
        assert_eq!(paths_of(&got.steps[1]), want);
    }

    /// One commit built in the index only (`update-index --index-info -z`),
    /// so a file name need not be valid UTF-8, nor be accepted by the
    /// filesystem (APFS refuses invalid UTF-8): `(name bytes, content)`.
    fn commit_index(r: &TempRepo, files: &[(&[u8], &str)], msg: &str) -> String {
        use std::io::Write;
        let mut info: Vec<u8> = Vec::new();
        for (name, content) in files {
            let mut child = std::process::Command::new(crate::git::git_binary())
                .args(["hash-object", "-w", "--stdin"])
                .current_dir(&r.path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(content.as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            let blob = String::from_utf8(out.stdout).unwrap();
            info.extend_from_slice(format!("100644 {}\t", blob.trim()).as_bytes());
            info.extend_from_slice(name);
            info.push(0);
        }
        let mut child = std::process::Command::new(crate::git::git_binary())
            .args(["update-index", "-z", "--index-info"])
            .current_dir(&r.path)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&info).unwrap();
        assert!(child.wait().unwrap().success());
        r.git(&["commit", "-q", "-m", msg]);
        r.git(&["rev-parse", "HEAD"])
    }

    const LATIN1: &[u8] = b"caf\xe9.txt";
    const LATIN1_ERR: &str = "Combined diffs do not support the file name: caf\\xe9.txt";

    fn combined_err(r: &TempRepo, hashes: &[&String]) -> String {
        let hashes: Vec<String> = hashes.iter().map(|h| h.to_string()).collect();
        combined_diff(&cwd(r), &hashes, None).unwrap_err()
    }

    /// A name that is not UTF-8 would be decoded lossily (`caf\u{FFFD}.txt`)
    /// and then match nothing: silently gone from net and fallback alike.
    /// The replay refuses it, the invalid bytes shown as `\xNN`.
    #[test]
    fn non_utf8_name_in_a_clean_replay_is_refused() {
        let r = TempRepo::new();
        let f1 = ten("l").replacen("l1\n", "A1\n", 1);
        commit_index(&r, &[(LATIN1, &ten("l")), (b"g", "g\n")], "base");
        let a = commit_index(&r, &[(LATIN1, &f1)], "A");
        commit_index(&r, &[(b"g", "g2\n")], "B");
        let c = commit_index(&r, &[(LATIN1, &f1.replacen("l10\n", "C10\n", 1))], "C");
        assert_eq!(combined_err(&r, &[&a, &c]), LATIN1_ERR);
    }

    /// The name first reaches the replay in `merge-tree`'s conflicted list:
    /// A never touches it, B (unselected) and C change the same line.
    #[test]
    fn non_utf8_conflicted_name_is_refused() {
        let r = TempRepo::new();
        commit_index(&r, &[(LATIN1, "x=1\n"), (b"f", "1\n")], "base");
        let a = commit_index(&r, &[(b"f", "2\n")], "A");
        commit_index(&r, &[(LATIN1, "x=2\n")], "B");
        let c = commit_index(&r, &[(LATIN1, "x=3\n")], "C");
        assert_eq!(combined_err(&r, &[&a, &c]), LATIN1_ERR);
    }

    /// Invalid bytes are escaped one by one; the valid text around them,
    /// multi-byte characters included, is kept.
    #[test]
    fn escape_invalid_utf8_escapes_only_the_invalid_bytes() {
        assert_eq!(escape_invalid_utf8(b"caf\xe9.txt"), "caf\\xe9.txt");
        assert_eq!(escape_invalid_utf8("é/ok".as_bytes()), "é/ok");
        // A truncated 3-byte sequence, a lone continuation byte, an overlong
        // encoding and a surrogate.
        assert_eq!(
            escape_invalid_utf8(b"a\xe2\x82b\x80c\xc0\xafd\xed\xa0\x80"),
            "a\\xe2\\x82b\\x80c\\xc0\\xafd\\xed\\xa0\\x80"
        );
    }

    #[test]
    fn check_names_refuses_a_misread_name() {
        let d = |path: &str, old: Option<&str>| GitDiff {
            path: path.to_string(),
            hunks: Vec::new(),
            status: None,
            old_path: old.map(str::to_string),
            truncated_from_bytes: None,
            is_directory: None,
            new_files: None,
            nested_repo: None,
        };
        let listed = vec![
            (None, "plan b/f.txt".to_string()),
            (Some("o".to_string()), "n".to_string()),
        ];
        assert_eq!(
            check_names(&[d("plan b/f.txt", None), d("n", Some("o"))], &listed),
            Ok(())
        );
        assert_eq!(
            check_names(&[d("f.txt", None), d("n", Some("o"))], &listed),
            Err("Combined diffs do not support the file name: f.txt".to_string())
        );
        // A name the parser dropped.
        assert_eq!(
            check_names(&[d("n", Some("o"))], &listed),
            Err("Combined diffs do not support the file name: plan b/f.txt".to_string())
        );
    }

    /// A conflicting commit that also touches thousands of long paths: they
    /// all join the fallback as companions, more bytes than an argv holds
    /// (1 MB on macOS, 2 MB on Linux, 32 KB on Windows). The per-commit diffs
    /// list them in small pathspec batches, never all at once.
    #[test]
    fn thousands_of_fallback_paths_fit() {
        let r = TempRepo::new();
        let dir = ["d".repeat(200), "e".repeat(200), "f".repeat(200)].join("/");
        let names: Vec<String> = (0..2800)
            .map(|i| format!("{dir}/{i:05}{}", "n".repeat(190)))
            .collect();
        commit_files(&r, &[("c.txt", Some("1\n"))], "base");
        let a = commit_files(&r, &[("c.txt", Some("2\n"))], "A");
        commit_files(&r, &[("c.txt", Some("3\n"))], "B");
        let mut files: Vec<(&str, Option<&str>)> =
            names.iter().map(|n| (n.as_str(), Some("x\n"))).collect();
        files.push(("c.txt", Some("4\n")));
        let c = commit_files(&r, &files, "C");
        let got = run(&r, &[&a, &c], None);
        assert_eq!(got.fallback.len(), names.len() + 1);
        assert!(got.fallback.iter().all(|f| !f.per_commit.is_empty()));
    }

    #[test]
    fn pathspec_batches_stay_under_the_argv_budget() {
        let long = |i: usize| format!("{i:04}{}", "p".repeat(300));
        let mut units: Vec<Vec<String>> = (0..60).map(|i| vec![long(i)]).collect();
        // A rename pair is one unit: never split across two batches.
        units.insert(17, vec![long(900), long(901)]);
        // A unit larger than the budget goes alone.
        units.push(vec!["x".repeat(PATHSPEC_BATCH_BYTES + 10)]);
        let batches = pathspec_batches(units.clone(), PATHSPEC_BATCH_BYTES);
        assert!(batches.len() > 3, "spans several batches");
        for b in &batches {
            let bytes: usize = b.iter().map(|p| p.len() + 1).sum();
            assert!(bytes <= PATHSPEC_BATCH_BYTES || b.len() == 1, "{bytes}");
            assert!(!b.is_empty());
        }
        let flat: Vec<String> = batches.concat();
        assert_eq!(flat, units.concat());
        assert!(batches
            .iter()
            .any(|b| b.contains(&long(900)) && b.contains(&long(901))));
    }

    /// The per-commit diffs of the fallback list the fallback paths in
    /// batches: a rename spanning many batches keeps its pair, a file of the
    /// same commit outside the fallback is never diffed.
    #[test]
    fn fallback_diffs_go_in_pathspec_batches() {
        let r = TempRepo::new();
        let names: Vec<String> = (0..120)
            .map(|i| format!("dir/{i:05}{}", "n".repeat(240)))
            .collect();
        commit_files(
            &r,
            &[("c.txt", Some("1\n")), ("old.txt", Some(&ten("o")))],
            "base",
        );
        let a = commit_files(&r, &[("c.txt", Some("2\n"))], "A");
        commit_files(&r, &[("c.txt", Some("3\n"))], "B");
        r.git(&["mv", "old.txt", "new.txt"]);
        let mut files: Vec<(&str, Option<&str>)> =
            names.iter().map(|n| (n.as_str(), Some("x\n"))).collect();
        files.push(("c.txt", Some("4\n")));
        let c = commit_files(&r, &files, "C");
        let got = run(&r, &[&a, &c], None);
        // `old.txt` owns no entry: the rename belongs to `new.txt`.
        assert_eq!(got.fallback.len(), names.len() + 2);
        assert!(got.fallback.iter().all(|f| !f.per_commit.is_empty()));
        let renamed = got.fallback.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(
            renamed.per_commit[0].diff.old_path.as_deref(),
            Some("old.txt")
        );
    }
}

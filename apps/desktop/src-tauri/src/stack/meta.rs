//! Stack metadata in the repo's local git config.
//!
//! Per branch `<b>`: `branch.<b>.gitwandParent` (the layer below),
//! `branch.<b>.gitwandStackBase` (merge-base with that parent when declared,
//! moved by restacks) and `branch.<b>.gitwandRestack` (a pending restack
//! record, kept on the stack's top). The key is `gitwandStackBase`, never
//! `gitwandBase`, which the worktree service owns.

use super::{Moment, PendingRestack, StackMeta};
use crate::git::git_cmd;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Output;

const PARENT: &str = "gitwandParent";
const BASE: &str = "gitwandStackBase";
const RESTACK: &str = "gitwandRestack";

fn run(repo: &Path, args: &[&str]) -> Result<Output, String> {
    git_cmd()
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))
}

fn run_ok(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(repo, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn key(branch: &str, var: &str) -> String {
    format!("branch.{branch}.{var}")
}

/// Refuses an empty name, a leading `-` (option injection) and anything
/// `git check-ref-format --branch` rejects.
pub(crate) fn validate_branch_name(name: &str) -> Result<(), String> {
    let invalid = || format!("invalid branch name: {name}");
    // `@{-1}` / `@{u}` would expand against whatever repo the cwd is in.
    if name.is_empty() || name.starts_with('-') || name.starts_with("@{") {
        return Err(invalid());
    }
    let ok = git_cmd()
        .args(["check-ref-format", "--branch", name])
        .current_dir(std::env::temp_dir())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn moment_str(m: Moment) -> &'static str {
    match m {
        Moment::ParentMoved => "parent_moved",
        Moment::ParentMerged => "parent_merged",
    }
}

impl PendingRestack {
    /// `<moment> <onto> <old_base> <bottom> <new_parent|-> <original>`
    // Consumed by Task 5 (run, pending record) of the stacked-branches plan.
    #[allow(dead_code)]
    pub fn to_config(&self) -> String {
        format!(
            "{} {} {} {} {} {}",
            moment_str(self.moment),
            self.onto,
            self.old_base,
            self.bottom,
            self.new_parent.as_deref().unwrap_or("-"),
            self.original
        )
    }

    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.split(' ').collect();
        let [moment, onto, old_base, bottom, new_parent, original] = parts.as_slice() else {
            return None;
        };
        let moment = match *moment {
            "parent_moved" => Moment::ParentMoved,
            "parent_merged" => Moment::ParentMerged,
            _ => return None,
        };
        if !is_sha(onto) || !is_sha(old_base) || bottom.is_empty() || original.is_empty() {
            return None;
        }
        Some(PendingRestack {
            moment,
            onto: (*onto).to_string(),
            old_base: (*old_base).to_string(),
            bottom: (*bottom).to_string(),
            new_parent: (*new_parent != "-").then(|| (*new_parent).to_string()),
            original: (*original).to_string(),
        })
    }
}

/// Every declared layer, keyed by branch name. Branches lacking a
/// `gitwandParent` are not layers and are skipped.
pub(crate) fn read_all(repo: &Path) -> Result<BTreeMap<String, StackMeta>, String> {
    let out = run(
        repo,
        &[
            "config",
            "--local",
            "--get-regexp",
            r"^branch\..*\.gitwand(parent|stackbase|restack)$",
        ],
    )?;
    // exit 1 = no match
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parents: BTreeMap<String, String> = BTreeMap::new();
    let mut bases: BTreeMap<String, String> = BTreeMap::new();
    let mut pendings: BTreeMap<String, PendingRestack> = BTreeMap::new();
    for line in text.lines() {
        let (k, value) = line.split_once(' ').unwrap_or((line, ""));
        let Some(rest) = k.strip_prefix("branch.") else {
            continue;
        };
        // Branch names may contain dots: the variable is after the last one.
        let Some((name, var)) = rest.rsplit_once('.') else {
            continue;
        };
        match var {
            "gitwandparent" => {
                parents.insert(name.to_string(), value.to_string());
            }
            "gitwandstackbase" => {
                bases.insert(name.to_string(), value.to_string());
            }
            "gitwandrestack" => {
                if let Some(p) = PendingRestack::parse(value) {
                    pendings.insert(name.to_string(), p);
                }
            }
            _ => {}
        }
    }
    Ok(parents
        .into_iter()
        .filter(|(_, parent)| !parent.is_empty())
        .map(|(branch, parent)| {
            let meta = StackMeta {
                base: bases.remove(&branch),
                pending: pendings.remove(&branch),
                branch: branch.clone(),
                parent,
            };
            (branch, meta)
        })
        .collect())
}

fn local_branch_exists(repo: &Path, name: &str) -> bool {
    run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}^{{commit}}"),
        ],
    )
    .map(|o| o.status.success())
    .unwrap_or(false)
}

/// The configured trunk, or the repo's detected one; `None` when there is
/// none (never the current branch). A leading `origin/` is stripped.
pub(crate) fn trunk(repo: &Path, configured: Option<&str>) -> Option<String> {
    let cwd = repo.to_str()?;
    let name = crate::git::cmd::resolve_default_branch_strict(cwd, configured)?;
    Some(name.strip_prefix("origin/").unwrap_or(&name).to_string())
}

/// Declares `parent` as the layer below `layer` and records the merge-base.
// Consumed by Task 6 (Tauri commands) of the stacked-branches plan.
#[allow(dead_code)]
pub(crate) fn set_parent(
    repo: &Path,
    trunk_name: Option<&str>,
    layer: &str,
    parent: &str,
) -> Result<StackMeta, String> {
    validate_branch_name(layer)?;
    validate_branch_name(parent)?;
    if layer == parent {
        return Err("A branch cannot be stacked on itself.".into());
    }
    if let Some(t) = trunk_name {
        if layer == t {
            return Err(format!("{layer} is the trunk and cannot be stacked."));
        }
        if parent == t {
            return Err(format!(
                "{parent} is the trunk: stacking on it is not a stack. Use Unstack instead."
            ));
        }
    }
    for b in [layer, parent] {
        if !local_branch_exists(repo, b) {
            return Err(format!("Unknown local branch: {b}"));
        }
    }
    let all = read_all(repo)?;
    if let Some(child) = all
        .values()
        .find(|m| m.parent == parent && m.branch != layer)
    {
        return Err(format!(
            "{parent} already has a stacked branch ({0}). Stacks are linear for now: stack on {0} instead.",
            child.branch
        ));
    }
    let mut cur = parent;
    for _ in 0..64 {
        let Some(m) = all.get(cur) else { break };
        if m.parent == layer {
            return Err(format!(
                "Stacking {layer} on {parent} would create a cycle."
            ));
        }
        cur = &m.parent;
    }
    let mb = run(
        repo,
        &[
            "merge-base",
            &format!("refs/heads/{layer}"),
            &format!("refs/heads/{parent}"),
        ],
    )?;
    let base = if mb.status.success() {
        Some(String::from_utf8_lossy(&mb.stdout).trim().to_string()).filter(|s| !s.is_empty())
    } else if mb.status.code() == Some(1) {
        None // no common ancestor
    } else {
        return Err(String::from_utf8_lossy(&mb.stderr).trim().to_string());
    };

    // Base first, parent last: a layer without a parent is not declared, and
    // if the parent write fails the previous base is put back.
    let previous_base = all.get(layer).and_then(|m| m.base.clone());
    match &base {
        Some(sha) => set_base(repo, layer, sha)?,
        None => unset_key(repo, &key(layer, BASE))?,
    }
    if let Err(e) = run_ok(repo, &["config", "--local", &key(layer, PARENT), parent]) {
        let _ = match &previous_base {
            Some(sha) => set_base(repo, layer, sha),
            None => unset_key(repo, &key(layer, BASE)),
        };
        return Err(e);
    }
    let pending = read_all(repo)?.remove(layer).and_then(|m| m.pending);
    Ok(StackMeta {
        branch: layer.to_string(),
        parent: parent.to_string(),
        base,
        pending,
    })
}

fn unset_key(repo: &Path, k: &str) -> Result<(), String> {
    let out = run(repo, &["config", "--local", "--unset", k])?;
    // exit 5: the key was not set
    if out.status.success() || out.status.code() == Some(5) {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Removes the three stack keys of `layer`; absent keys are fine.
// Consumed by Task 6 (Tauri commands) of the stacked-branches plan.
#[allow(dead_code)]
pub(crate) fn unset(repo: &Path, layer: &str) -> Result<(), String> {
    validate_branch_name(layer)?;
    for var in [PARENT, BASE, RESTACK] {
        unset_key(repo, &key(layer, var))?;
    }
    Ok(())
}

pub(crate) fn set_base(repo: &Path, layer: &str, sha: &str) -> Result<(), String> {
    validate_branch_name(layer)?;
    run_ok(repo, &["config", "--local", &key(layer, BASE), sha]).map(|_| ())
}

// Consumed by Task 5 (run, pending record) of the stacked-branches plan.
#[allow(dead_code)]
pub(crate) fn set_pending(repo: &Path, top: &str, p: &PendingRestack) -> Result<(), String> {
    validate_branch_name(top)?;
    run_ok(
        repo,
        &["config", "--local", &key(top, RESTACK), &p.to_config()],
    )
    .map(|_| ())
}

// Consumed by Task 5 (run, pending record) of the stacked-branches plan.
#[allow(dead_code)]
pub(crate) fn clear_pending(repo: &Path, top: &str) -> Result<(), String> {
    validate_branch_name(top)?;
    unset_key(repo, &key(top, RESTACK))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;

    /// main <- step-1 (a.txt) <- step-2 (b.txt); returns the step-1 tip.
    fn two_layers(r: &TempRepo) -> String {
        r.git(&["checkout", "-q", "-b", "step-1"]);
        let s1 = r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "2\n", "s2");
        s1
    }

    fn config_is_set(r: &TempRepo, k: &str) -> bool {
        git_cmd()
            .args(["config", "--get", k])
            .current_dir(&r.path)
            .status()
            .unwrap()
            .success()
    }

    #[test]
    fn set_parent_records_parent_and_merge_base() {
        let r = TempRepo::new();
        let s1 = two_layers(&r);
        let m = set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        assert_eq!(m.parent, "step-1");
        assert_eq!(m.base.as_deref(), Some(s1.as_str()));
        assert_eq!(
            r.git(&["config", "--get", "branch.step-2.gitwandStackBase"]),
            s1
        );
        // never writes the worktree service's key
        assert!(!config_is_set(&r, "branch.step-2.gitwandBase"));
    }

    #[test]
    fn a_second_child_on_the_same_parent_is_refused() {
        let r = TempRepo::new();
        two_layers(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        assert_eq!(
            set_parent(&r.path, Some("main"), "step-3", "step-1").unwrap_err(),
            "step-1 already has a stacked branch (step-2). Stacks are linear for now: stack on step-2 instead."
        );
    }

    #[test]
    fn re_declaring_the_same_child_is_allowed() {
        let r = TempRepo::new();
        let s1 = two_layers(&r);
        let first = set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        let second = set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        assert_eq!(first, second);
        assert_eq!(second.parent, "step-1");
        assert_eq!(second.base.as_deref(), Some(s1.as_str()));
        assert_eq!(
            r.git(&["config", "--get", "branch.step-2.gitwandParent"]),
            "step-1"
        );
        assert_eq!(
            r.git(&["config", "--get", "branch.step-2.gitwandStackBase"]),
            s1
        );
    }

    #[test]
    fn re_declaring_keeps_a_pending_record() {
        // set_parent never touches the restack key: a pending record survives
        // a re-declaration and is reported back.
        let r = TempRepo::new();
        two_layers(&r);
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        let p = PendingRestack {
            moment: Moment::ParentMoved,
            onto: "a".repeat(40),
            old_base: "b".repeat(40),
            bottom: "step-2".into(),
            new_parent: None,
            original: "step-1".into(),
        };
        set_pending(&r.path, "step-2", &p).unwrap();
        let m = set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        assert_eq!(m.pending, Some(p.clone()));
        assert_eq!(read_all(&r.path).unwrap()["step-2"].pending, Some(p));
    }

    #[test]
    fn an_unknown_layer_is_refused() {
        let r = TempRepo::new();
        r.git(&["branch", "A"]);
        assert_eq!(
            set_parent(&r.path, Some("main"), "ghost", "A").unwrap_err(),
            "Unknown local branch: ghost"
        );
        assert!(read_all(&r.path).unwrap().is_empty());
    }

    #[test]
    fn a_three_link_cycle_is_refused() {
        let r = TempRepo::new();
        for b in ["A", "B", "C"] {
            r.git(&["branch", b]);
        }
        set_parent(&r.path, Some("main"), "A", "B").unwrap();
        set_parent(&r.path, Some("main"), "B", "C").unwrap();
        assert_eq!(
            set_parent(&r.path, Some("main"), "C", "A").unwrap_err(),
            "Stacking C on A would create a cycle."
        );
        assert!(!read_all(&r.path).unwrap().contains_key("C"));
    }

    #[test]
    fn unrelated_histories_have_no_base_and_drop_a_stale_one() {
        let r = TempRepo::new();
        two_layers(&r);
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        r.git(&["branch", "other", "main"]);
        r.git(&["checkout", "-q", "--orphan", "island"]);
        r.git(&["rm", "-rfq", "."]);
        r.commit("z.txt", "z\n", "island");
        r.git(&["config", "branch.island.gitwandStackBase", &"d".repeat(40)]);
        let m = set_parent(&r.path, Some("main"), "island", "other").unwrap();
        assert_eq!(m.base, None);
        assert!(!config_is_set(&r, "branch.island.gitwandStackBase"));
    }

    #[test]
    fn cycles_self_and_trunk_are_refused() {
        let r = TempRepo::new();
        r.git(&["branch", "A"]);
        r.git(&["branch", "B"]);
        let p = &r.path;
        set_parent(p, Some("main"), "A", "B").unwrap();
        assert_eq!(
            set_parent(p, Some("main"), "B", "A").unwrap_err(),
            "Stacking B on A would create a cycle."
        );
        assert_eq!(
            set_parent(p, Some("main"), "A", "A").unwrap_err(),
            "A branch cannot be stacked on itself."
        );
        assert_eq!(
            set_parent(p, Some("main"), "A", "main").unwrap_err(),
            "main is the trunk: stacking on it is not a stack. Use Unstack instead."
        );
        assert_eq!(
            set_parent(p, Some("main"), "main", "A").unwrap_err(),
            "main is the trunk and cannot be stacked."
        );
        assert_eq!(
            set_parent(p, Some("main"), "-x", "A").unwrap_err(),
            "invalid branch name: -x"
        );
        assert_eq!(
            set_parent(p, Some("main"), "A", "nope").unwrap_err(),
            "Unknown local branch: nope"
        );
    }

    #[test]
    fn read_all_round_trips_dotted_slashed_and_capitalised_names() {
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "release/1.2"]);
        r.commit("a.txt", "1\n", "r");
        r.git(&["checkout", "-q", "-b", "Feat/Step.2"]);
        r.commit("b.txt", "2\n", "f");
        set_parent(&r.path, Some("main"), "Feat/Step.2", "release/1.2").unwrap();
        let all = read_all(&r.path).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all["Feat/Step.2"].parent, "release/1.2");
        assert!(all["Feat/Step.2"].base.is_some());
    }

    #[test]
    fn read_all_is_empty_without_stack_keys() {
        let r = TempRepo::new();
        assert!(read_all(&r.path).unwrap().is_empty());
    }

    #[test]
    fn pending_record_round_trips_and_rejects_garbage() {
        let p = PendingRestack {
            moment: Moment::ParentMerged,
            onto: "a".repeat(40),
            old_base: "b".repeat(40),
            bottom: "step-2".into(),
            new_parent: None,
            original: "step-1".into(),
        };
        assert_eq!(
            p.to_config(),
            format!(
                "parent_merged {} {} step-2 - step-1",
                "a".repeat(40),
                "b".repeat(40)
            )
        );
        assert_eq!(PendingRestack::parse(&p.to_config()), Some(p));
        assert_eq!(PendingRestack::parse("parent_moved abc"), None);
    }

    #[test]
    fn pending_is_stored_read_and_cleared_on_the_top() {
        let r = TempRepo::new();
        two_layers(&r);
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        let p = PendingRestack {
            moment: Moment::ParentMoved,
            onto: "a".repeat(40),
            old_base: "b".repeat(40),
            bottom: "step-2".into(),
            new_parent: Some("main".into()),
            original: "step-1".into(),
        };
        set_pending(&r.path, "step-2", &p).unwrap();
        assert_eq!(read_all(&r.path).unwrap()["step-2"].pending, Some(p));
        clear_pending(&r.path, "step-2").unwrap();
        clear_pending(&r.path, "step-2").unwrap();
        assert_eq!(read_all(&r.path).unwrap()["step-2"].pending, None);
    }

    #[test]
    fn set_base_overwrites_the_recorded_base() {
        let r = TempRepo::new();
        two_layers(&r);
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        let sha = "c".repeat(40);
        set_base(&r.path, "step-2", &sha).unwrap();
        assert_eq!(
            read_all(&r.path).unwrap()["step-2"].base.as_deref(),
            Some(sha.as_str())
        );
    }

    #[test]
    fn unset_removes_only_stack_keys() {
        let r = TempRepo::new();
        two_layers(&r);
        r.git(&["config", "branch.step-2.remote", "origin"]);
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        r.git(&[
            "config",
            "branch.step-2.gitwandRestack",
            &format!(
                "parent_moved {} {} step-2 - step-1",
                "a".repeat(40),
                "b".repeat(40)
            ),
        ]);
        unset(&r.path, "step-2").unwrap();
        for v in [PARENT, BASE, RESTACK] {
            assert!(!config_is_set(&r, &key("step-2", v)), "{v} still set");
        }
        assert_eq!(
            r.git(&["config", "--get", "branch.step-2.remote"]),
            "origin"
        );
        unset(&r.path, "step-2").unwrap();
    }

    #[test]
    fn trunk_never_falls_back_to_the_current_branch() {
        let r = TempRepo::new();
        r.git(&["branch", "-m", "main", "feature"]);
        assert_eq!(trunk(&r.path, None), None);
        assert_eq!(
            crate::git::cmd::resolve_default_branch(r.path.to_str().unwrap(), None),
            "feature"
        );
    }

    #[test]
    fn trunk_strips_origin_prefix_and_honours_configuration() {
        let r = TempRepo::new();
        assert_eq!(trunk(&r.path, None).as_deref(), Some("main"));
        r.git(&["branch", "develop"]);
        assert_eq!(trunk(&r.path, Some("develop")).as_deref(), Some("develop"));
        // only the remote-tracking ref survives: "origin/main" -> "main"
        r.add_bare_origin();
        r.git(&["branch", "-m", "main", "local-only"]);
        assert_eq!(trunk(&r.path, None).as_deref(), Some("main"));
    }

    #[test]
    fn validate_branch_name_refuses_bad_names() {
        assert_eq!(
            validate_branch_name("").unwrap_err(),
            "invalid branch name: "
        );
        assert_eq!(
            validate_branch_name("-x").unwrap_err(),
            "invalid branch name: -x"
        );
        assert!(validate_branch_name("bad..name").is_err());
        assert!(validate_branch_name("feat/ok.1").is_ok());
        // `@{-1}` / `@{u}` expand against the cwd's repo: never accepted
        assert_eq!(
            validate_branch_name("@{-1}").unwrap_err(),
            "invalid branch name: @{-1}"
        );
        assert!(validate_branch_name("@{u}").is_err());
    }
}

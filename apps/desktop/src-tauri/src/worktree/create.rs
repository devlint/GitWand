//! Creating a worktree (spec §5): branch, base, directory, `git worktree
//! add`, the record, then `include`. `setup` is not run here: the frontend
//! runs it in a terminal tab once the user's trust answer is known.

use super::base::{self, BaseResolution};
use super::include::{self, IncludeWarning};
use super::record::{self, Kind, WorktreeRecord};
use super::{settings, slug};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) struct CreateRequest {
    pub name: String,
    pub base: Option<String>,
    pub branch: Option<String>,
    pub path: Option<String>,
    pub kind: Kind,
}

#[derive(Serialize, Debug)]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
    /// `{name}` for this worktree's hooks.
    pub name: String,
    pub kind: Kind,
    pub base: BaseResolution,
    pub warnings: Vec<IncludeWarning>,
    pub created_at: u64,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::git::git_cmd()
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn branch_exists(root: &Path, branch: &str) -> bool {
    git(
        root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

fn valid_branch(root: &Path, branch: &str) -> Result<(), String> {
    if branch.starts_with('-') || git(root, &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("Not a valid branch name: {branch}"));
    }
    Ok(())
}

/// An explicit path: absolute, and either missing or an empty directory.
fn usable_path(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p.trim());
    // `safe_repo_path` cannot apply: a new worktree lives outside the repo
    // and does not exist yet. An absolute path with no `..` instead.
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "The worktree path must be absolute, without `..`: {p}"
        ));
    }
    if path.exists() {
        let empty = path.is_dir()
            && std::fs::read_dir(&path)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false);
        if !empty {
            return Err(format!("{} already exists.", path.display()));
        }
    }
    Ok(path)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn create_worktree(
    cwd: &Path,
    req: CreateRequest,
    fetch_timeout: Duration,
) -> Result<CreatedWorktree, String> {
    let main = crate::commands::worktree_trust::main_worktree_root(&cwd.to_string_lossy())?;
    let slug = slug::slugify(&req.name)
        .ok_or_else(|| "The name needs at least one letter or digit.".to_string())?;
    let cfg = settings::read_settings(&main);

    let given_branch = req
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    let default_branch = given_branch.is_none();
    let mut branch = given_branch.unwrap_or_else(|| format!("task/{slug}"));
    valid_branch(&main, &branch)?;
    let explicit_base = req
        .base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);

    // An existing branch the user named is checked out as is.
    let checkout = !default_branch && branch_exists(&main, &branch);
    if checkout && explicit_base.is_some() {
        return Err(format!("Branch {branch} already exists."));
    }

    let base = if checkout {
        let commit = git(
            &main,
            &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
        )?;
        BaseResolution {
            base_ref: branch.clone(),
            commit,
            fetched_at: None,
            fallback_reason: None,
            fallback_detail: None,
        }
    } else {
        match &explicit_base {
            Some(b) => base::resolve_explicit_base(&main, b)?,
            None => base::resolve_default_base(&main, fetch_timeout)?,
        }
    };

    let default_path = req
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .is_none();
    let dir = settings::worktrees_dir(&main, &cfg);
    let mut path = match req.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => usable_path(p)?,
        None => dir.join(&slug),
    };
    // A default name that is taken gets the smallest free suffix.
    let mut n = 1;
    while (default_path && path.exists()) || (default_branch && branch_exists(&main, &branch)) {
        n += 1;
        // Room for the suffix within the 63-char cap, so `{name}` (the
        // directory's slug) stays unique: it keys the hooks' external state.
        let suffix = format!("-{n}");
        let stem: String = slug.chars().take(63 - suffix.len()).collect();
        let name = format!("{}{suffix}", stem.trim_end_matches('-'));
        if default_path {
            path = dir.join(&name);
        }
        if default_branch {
            branch = format!("task/{name}");
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let path_str = path.to_string_lossy().to_string();
    let add = if checkout {
        git(&main, &["worktree", "add", &path_str, "--", &branch])
    } else {
        // Started from a commit, so the new branch tracks nothing (§5.2).
        git(
            &main,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &path_str,
                "--",
                &base.commit,
            ],
        )
    };
    add.map_err(|e| format!("git worktree add failed: {e}"))?;
    // Canonical, without Windows' `\\?\` prefix: what hooks, the record and
    // the frontend see.
    let path = PathBuf::from(super::hooks::display_path(
        &path.canonicalize().unwrap_or(path),
    ));

    let rollback = |e: String| -> String {
        let p = path.to_string_lossy().to_string();
        let _ = git(&main, &["worktree", "remove", "--force", &p]);
        let _ = git(&main, &["worktree", "prune"]);
        if !checkout {
            let _ = git(&main, &["branch", "-D", &branch]);
        }
        e
    };

    let created_at = now();
    let source_branch = git(&main, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty());
    let common = record::common_dir(&main).map_err(rollback)?;
    record::upsert(
        &common,
        WorktreeRecord {
            path: path.to_string_lossy().to_string(),
            branch: branch.clone(),
            base_ref: base.base_ref.clone(),
            base_commit: base.commit.clone(),
            created_at,
            kind: req.kind,
            source_branch,
        },
    )
    .map_err(rollback)?;
    if req.kind == Kind::Task && !checkout {
        // Read by the merge-back guard (scratch.rs) until merge-back moves
        // onto the record: it refuses while the main checkout lacks the base.
        for (key, value) in [
            (format!("branch.{branch}.gitwandBase"), &base.commit),
            (format!("branch.{branch}.gitwandSource"), &base.base_ref),
        ] {
            if let Err(e) = git(&main, &["config", &key, value]) {
                let _ = record::remove(&common, &path);
                return Err(rollback(e));
            }
        }
    }

    let warnings = include::apply_include(&main, &path, &cfg.include);
    let name = path
        .file_name()
        .and_then(|n| slug::slugify(&n.to_string_lossy()))
        .unwrap_or(slug);
    Ok(CreatedWorktree {
        path: path.to_string_lossy().to_string(),
        branch,
        name,
        kind: req.kind,
        base,
        warnings,
        created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;

    const T: Duration = Duration::from_secs(20);

    fn req(name: &str, kind: Kind) -> CreateRequest {
        CreateRequest {
            name: name.into(),
            base: None,
            branch: None,
            path: None,
            kind,
        }
    }

    #[test]
    fn create_uses_default_dir_branch_and_records() {
        let repo = TempRepo::new();
        let c = create_worktree(&repo.path, req("Fix Login", Kind::Manual), T).unwrap();
        let expected = repo.sandbox.join("repo.worktrees").join("fix-login");
        assert_eq!(PathBuf::from(&c.path), expected);
        assert_eq!(c.branch, "task/fix-login");
        assert_eq!(c.name, "fix-login");
        assert!(expected.join("README.md").is_file());
        // No upstream.
        assert!(!repo
            .git(&["config", "--list"])
            .contains("branch.task/fix-login.merge"));
        let common = record::common_dir(&repo.path).unwrap();
        let r = record::find(&common, &expected).unwrap();
        assert_eq!(r.kind, Kind::Manual);
        assert_eq!(r.branch, "task/fix-login");
        assert_eq!(r.base_ref, "main");
        assert_eq!(r.source_branch.as_deref(), Some("main"));
    }

    #[test]
    fn create_suffixes_on_collision() {
        let repo = TempRepo::new();
        create_worktree(&repo.path, req("fix-login", Kind::Manual), T).unwrap();
        let c = create_worktree(&repo.path, req("fix-login", Kind::Manual), T).unwrap();
        assert!(c.path.ends_with("fix-login-2"));
        assert_eq!(c.branch, "task/fix-login-2");
        assert_eq!(c.name, "fix-login-2");
    }

    /// `{name}` keys external state (Dendreo's databases, containers): two
    /// worktrees must never share it, even when the slug is at its 63-char cap.
    #[test]
    fn collision_suffix_keeps_name_unique_at_the_length_cap() {
        let repo = TempRepo::new();
        let long = "a".repeat(80);
        let a = create_worktree(&repo.path, req(&long, Kind::Manual), T).unwrap();
        let b = create_worktree(&repo.path, req(&long, Kind::Manual), T).unwrap();
        assert_ne!(a.name, b.name);
        assert!(b.name.len() <= 63, "{}", b.name);
        assert_eq!(
            Path::new(&b.path).file_name().unwrap().to_string_lossy(),
            b.name
        );
        assert_eq!(b.branch, format!("task/{}", b.name));
    }

    #[test]
    fn create_honours_dir_setting() {
        let repo = TempRepo::new();
        repo.write(".gitwandrc", r#"{"worktree":{"dir":"wt"}}"#);
        let c = create_worktree(&repo.path, req("x", Kind::Manual), T).unwrap();
        assert_eq!(PathBuf::from(&c.path), repo.path.join("wt").join("x"));
    }

    #[test]
    fn create_checks_out_an_existing_branch() {
        let repo = TempRepo::new();
        repo.git(&["branch", "feature"]);
        let mut r = req("feature", Kind::Manual);
        r.branch = Some("feature".into());
        let c = create_worktree(&repo.path, r, T).unwrap();
        assert_eq!(c.branch, "feature");
        assert_eq!(
            crate::worktree::test_support::git_at(
                Path::new(&c.path),
                &["symbolic-ref", "--short", "HEAD"]
            ),
            "feature"
        );
        let mut again = req("other", Kind::Manual);
        again.branch = Some("feature".into());
        again.base = Some("main".into());
        assert!(create_worktree(&repo.path, again, T).is_err());
    }

    #[test]
    fn create_refuses_relative_or_dotdot_paths() {
        let repo = TempRepo::new();
        for p in ["rel/x", "/tmp/../tmp/x"] {
            let mut r = req("x", Kind::Manual);
            r.path = Some(p.into());
            assert!(create_worktree(&repo.path, r, T).is_err(), "{p}");
        }
    }

    #[test]
    fn create_task_writes_merge_back_keys() {
        let repo = TempRepo::new();
        let c = create_worktree(&repo.path, req("t", Kind::Task), T).unwrap();
        assert_eq!(
            repo.git(&["config", "--get", "branch.task/t.gitwandBase"]),
            c.base.commit
        );
        assert_eq!(
            repo.git(&["config", "--get", "branch.task/t.gitwandSource"]),
            "main"
        );
    }

    #[test]
    fn create_brings_include_files() {
        let repo = TempRepo::new();
        repo.commit(".gitignore", ".env\n", "ignore");
        repo.write(".env", "K=1");
        repo.write(".gitwandrc", r#"{"worktree":{"include":[".env"]}}"#);
        let c = create_worktree(&repo.path, req("inc", Kind::Manual), T).unwrap();
        assert!(Path::new(&c.path).join(".env").is_file());
        // .gitwandrc is untracked, so not in the checkout, and not ignored.
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    }

    #[test]
    fn recorded_task_is_accepted_by_scratch_discard() {
        let repo = TempRepo::new();
        let c = create_worktree(&repo.path, req("x", Kind::Task), T).unwrap();
        crate::commands::scratch::scratch_worktree_discard_impl(
            repo.path.to_string_lossy().to_string(),
            c.path.clone(),
        )
        .unwrap();
        assert!(!Path::new(&c.path).exists());
        assert!(repo.git(&["branch", "--list", "task/x"]).is_empty());
        let common = record::common_dir(&repo.path).unwrap();
        assert!(record::find(&common, Path::new(&c.path)).is_none());
    }

    /// The fresh base is often ahead of local `main`: merge-back refuses (it
    /// would squash origin's commits too), and must say to update `main`,
    /// never to check out the remote-tracking ref (a detached HEAD).
    #[test]
    fn merge_back_refusal_says_to_update_main_when_the_base_is_remote() {
        use crate::worktree::test_support::git_at;
        let repo = TempRepo::new();
        let bare = repo.add_bare_origin();
        let other = repo.sandbox.join("other");
        git_at(
            &repo.sandbox,
            &["clone", "-q", bare.to_str().unwrap(), "other"],
        );
        git_at(&other, &["config", "user.email", "t@e.x"]);
        git_at(&other, &["config", "user.name", "T"]);
        std::fs::write(other.join("n.txt"), "n").unwrap();
        git_at(&other, &["add", "-A"]);
        git_at(&other, &["commit", "-q", "-m", "remote"]);
        git_at(&other, &["push", "-q", "origin", "main"]);

        let c = create_worktree(&repo.path, req("t", Kind::Task), T).unwrap();
        assert_eq!(c.base.base_ref, "origin/main");
        std::fs::write(Path::new(&c.path).join("w.txt"), "w").unwrap();
        let err = crate::commands::scratch::scratch_worktree_merge_back_impl(
            repo.path.to_string_lossy().to_string(),
            c.path.clone(),
            Some(false),
        )
        .unwrap_err();
        assert!(!err.contains("Check out origin/main"), "{err}");
        assert!(err.contains("Update main to origin/main"), "{err}");
    }

    #[test]
    fn a_manual_worktree_is_not_a_scratch() {
        let repo = TempRepo::new();
        let c = create_worktree(&repo.path, req("m", Kind::Manual), T).unwrap();
        assert!(crate::commands::scratch::scratch_worktree_discard_impl(
            repo.path.to_string_lossy().to_string(),
            c.path.clone(),
        )
        .is_err());
        assert!(Path::new(&c.path).exists());
    }
}

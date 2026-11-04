//! `include` (spec §5.3): ignored files and folders of the main worktree
//! brought into a new one, copied or linked. Only ignored paths, and only
//! inside the repo.

use super::settings::{IncludeEntry, IncludeMode};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct IncludeWarning {
    pub path: String,
    /// `tracked`, `not-ignored`, `outside`, `exists`, `symlink-fallback`,
    /// `link-skipped`, `error`.
    pub reason: String,
    pub detail: Option<String>,
}

fn warn(path: &str, reason: &str, detail: Option<String>) -> IncludeWarning {
    IncludeWarning {
        path: path.to_string(),
        reason: reason.to_string(),
        detail,
    }
}

fn git_status(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    crate::git::git_cmd()
        .args(args)
        .current_dir(root)
        .output()
        .ok()
}

fn is_pattern(entry: &str) -> bool {
    entry.contains(['*', '?', '['])
}

/// The paths an entry names: itself, or what a pattern matches among the
/// untracked files of the main worktree, file by file (`--directory` would
/// also list an untracked folder that merely holds a match).
fn expand(main_root: &Path, entry: &str) -> Vec<String> {
    if !is_pattern(entry) {
        return vec![entry.trim_end_matches('/').to_string()];
    }
    let Some(out) = git_status(
        main_root,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            &format!("--exclude={entry}"),
        ],
    ) else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .collect()
}

fn escapes(rel: &str) -> bool {
    let p = Path::new(rel);
    p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
}

fn is_ignored(main_root: &Path, rel: &str, is_dir: bool) -> bool {
    let ok = |p: &str| {
        git_status(main_root, &["check-ignore", "-q", "--", p])
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    ok(rel) || (is_dir && ok(&format!("{rel}/")))
}

fn is_tracked(main_root: &Path, rel: &str) -> bool {
    git_status(main_root, &["ls-files", "--error-unmatch", "--", rel])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn make_link(target: &Path, link: &Path, _is_dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn make_link(target: &Path, link: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

type LinkFn = dyn Fn(&Path, &Path, bool) -> std::io::Result<()>;

/// Recursive copy; links inside are copied as links.
fn copy_tree(src: &Path, dst: &Path, skipped: &mut Vec<PathBuf>) -> std::io::Result<()> {
    copy_tree_with(src, dst, &make_link, skipped)
}

fn copy_tree_with(
    src: &Path,
    dst: &Path,
    link: &LinkFn,
    skipped: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        // Recreated as a link, never followed: it may point outside the repo
        // or loop. When links cannot be made (Windows without Developer
        // Mode), it is skipped and reported.
        let target = std::fs::read_link(src)?;
        if link(&target, dst, src.is_dir()).is_err() {
            skipped.push(src.to_path_buf());
        }
        return Ok(());
    }
    if meta.is_dir() {
        copy_dir(src, dst, link, skipped)
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

fn copy_dir(
    src: &Path,
    dst: &Path,
    link: &LinkFn,
    skipped: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        copy_tree_with(&entry.path(), &dst.join(entry.file_name()), link, skipped)?;
    }
    Ok(())
}

fn bring(
    main_canon: &Path,
    worktree: &Path,
    rel: &str,
    mode: IncludeMode,
    warnings: &mut Vec<IncludeWarning>,
) {
    let src = main_canon.join(rel);
    if std::fs::symlink_metadata(&src).is_err() {
        return; // missing: skipped silently
    }
    let Ok(real) = src.canonicalize() else {
        warnings.push(warn(rel, "outside", None)); // dangling link
        return;
    };
    if !real.starts_with(main_canon) {
        warnings.push(warn(rel, "outside", None));
        return;
    }
    let is_dir = real.is_dir();
    if !is_ignored(main_canon, rel, is_dir) {
        let reason = if is_tracked(main_canon, rel) {
            "tracked"
        } else {
            "not-ignored"
        };
        warnings.push(warn(rel, reason, None));
        return;
    }
    let dst = worktree.join(rel);
    if std::fs::symlink_metadata(&dst).is_ok() {
        warnings.push(warn(rel, "exists", None));
        return;
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            warnings.push(warn(rel, "error", Some(e.to_string())));
            return;
        }
    }
    let mut skipped = Vec::new();
    let result = match mode {
        IncludeMode::Copy => copy_tree(&src, &dst, &mut skipped),
        IncludeMode::Symlink => match make_link(&real, &dst, is_dir) {
            Ok(()) => Ok(()),
            Err(e) => {
                warnings.push(warn(rel, "symlink-fallback", Some(e.to_string())));
                copy_tree(&src, &dst, &mut skipped)
            }
        },
    };
    if let Err(e) = result {
        warnings.push(warn(rel, "error", Some(e.to_string())));
    }
    for link in skipped {
        let shown = link
            .strip_prefix(main_canon)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| link.to_string_lossy().to_string());
        warnings.push(warn(&shown, "link-skipped", None));
    }
}

pub(crate) fn apply_include(
    main_root: &Path,
    worktree: &Path,
    entries: &[IncludeEntry],
) -> Vec<IncludeWarning> {
    let mut warnings = Vec::new();
    let main_canon: PathBuf = match main_root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            warnings.push(warn(".", "error", Some(e.to_string())));
            return warnings;
        }
    };
    for entry in entries {
        if escapes(&entry.path) {
            warnings.push(warn(&entry.path, "outside", None));
            continue;
        }
        for rel in expand(&main_canon, &entry.path) {
            if escapes(&rel) {
                warnings.push(warn(&rel, "outside", None));
                continue;
            }
            bring(&main_canon, worktree, &rel, entry.mode, &mut warnings);
        }
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;

    fn copy(p: &str) -> IncludeEntry {
        IncludeEntry {
            path: p.into(),
            mode: IncludeMode::Copy,
        }
    }

    fn setup() -> (TempRepo, PathBuf) {
        let repo = TempRepo::new();
        repo.commit(".gitignore", ".env\ncache/\n*.local\nout\n", "ignore");
        let wt = repo.sandbox.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        (repo, wt)
    }

    #[test]
    fn include_copies_ignored_files_and_dirs() {
        let (repo, wt) = setup();
        repo.write(".env", "SECRET=1\n");
        repo.write("cache/a/b.txt", "b");
        let w = apply_include(&repo.path, &wt, &[copy(".env"), copy("cache/")]);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(
            std::fs::read_to_string(wt.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join("cache/a/b.txt")).unwrap(),
            "b"
        );
        assert!(!std::fs::symlink_metadata(wt.join(".env"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn include_symlinks_when_asked() {
        let (repo, wt) = setup();
        repo.write(".env", "S");
        let w = apply_include(
            &repo.path,
            &wt,
            &[IncludeEntry {
                path: ".env".into(),
                mode: IncludeMode::Symlink,
            }],
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(
            std::fs::read_link(wt.join(".env")).unwrap(),
            repo.path.join(".env")
        );
    }

    #[test]
    fn include_skips_tracked_and_missing() {
        let (repo, wt) = setup();
        let w = apply_include(&repo.path, &wt, &[copy("README.md"), copy("nope.txt")]);
        assert_eq!(w, vec![warn("README.md", "tracked", None)]);
        assert!(!wt.join("README.md").exists());
        assert!(!wt.join("nope.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn include_refuses_outside_paths() {
        let (repo, wt) = setup();
        let outside = repo.sandbox.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("s.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, repo.path.join("out")).unwrap();
        let w = apply_include(&repo.path, &wt, &[copy("../outside"), copy("out")]);
        assert_eq!(
            w,
            vec![
                warn("../outside", "outside", None),
                warn("out", "outside", None)
            ]
        );
        assert!(std::fs::read_dir(&wt).unwrap().next().is_none());
    }

    /// Windows without Developer Mode cannot create links: a link inside an
    /// included folder is then skipped, never followed (it may point outside
    /// the repo, or loop, like pnpm's junctions).
    #[cfg(unix)]
    #[test]
    fn copy_never_follows_a_link_it_cannot_recreate() {
        let (repo, wt) = setup();
        let outside = repo.sandbox.join("secret");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("key"), "k").unwrap();
        repo.write("cache/ok.txt", "ok");
        std::os::unix::fs::symlink(&outside, repo.path.join("cache/ext")).unwrap();
        let fail = |_: &Path, _: &Path, _: bool| -> std::io::Result<()> {
            Err(std::io::Error::other("no symlink privilege"))
        };
        let mut skipped = Vec::new();
        copy_tree_with(
            &repo.path.join("cache"),
            &wt.join("cache"),
            &fail,
            &mut skipped,
        )
        .unwrap();
        assert!(wt.join("cache/ok.txt").is_file());
        assert!(!wt.join("cache/ext").exists());
        assert!(std::fs::symlink_metadata(wt.join("cache/ext")).is_err());
        assert_eq!(skipped, vec![repo.path.join("cache/ext")]);
    }

    #[test]
    fn include_expands_patterns() {
        let (repo, wt) = setup();
        repo.write("a.local", "a");
        repo.write("sub/b.local", "b");
        repo.write("c.txt", "c");
        let w = apply_include(&repo.path, &wt, &[copy("*.local")]);
        assert!(w.is_empty(), "{w:?}");
        assert!(wt.join("a.local").is_file());
        assert!(wt.join("sub/b.local").is_file());
        assert!(!wt.join("c.txt").exists());
    }
}

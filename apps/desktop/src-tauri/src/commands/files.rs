//! Filesystem Tauri commands (§3.4g migration).
//!
//! Five commands:
//!   - `read_file` / `write_file` — working-tree IO scoped by `safe_repo_path`.
//!   - `read_file_at_revision` — read a file as of an arbitrary git rev (or
//!     the working tree when `rev` is empty).
//!   - `folder_diff` — combined name-status + numstat tree for two refs,
//!     used by the diff browser to surface a folder-level summary.
//!   - `list_dir` — directory browser for the FolderPicker (handles macOS
//!     TCC-protected directories at $HOME without triggering prompts).
//!   - `list_repo_dir` — one level of the working tree for the Files view
//!     (v3.11.2), git-aware: ignored entries are classified with libgit2.
//!
//! All helpers used here (safe_repo_path, git_cmd, parse_name_status_z,
//! parse_numstat_z, folder_diff_args, insert_change, sort_node,
//! guess_mime_from_ext) live in `crate::git::*` (parse.rs / cmd.rs).

use crate::git::*;
use crate::types::*;
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn read_file(cwd: String, path: String) -> Result<String, String> {
    let full = safe_repo_path(&cwd, &path)?;
    require_git_worktree(&cwd)?;
    std::fs::read_to_string(&full).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub(crate) async fn write_file(cwd: String, path: String, content: String) -> Result<(), String> {
    let full = safe_repo_path(&cwd, &path)?;
    require_git_worktree(&cwd)?;
    // `safe_repo_path` resolves a symlink that leads somewhere real, so `full`
    // is only still a symlink when it dangles (or loops). Writing through it
    // would create its target, wherever that is, including outside the repo.
    if full
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "refusing to write through a symlink that does not resolve: {}",
            path
        ));
    }
    std::fs::write(&full, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// v2.5 — Write `.gitwandrc` (or `.gitwandrc.json` if it already exists).
///
/// Detects which format is present in the repo:
///   - `.gitwandrc.json` exists → writes there (keeps the existing format)
///   - otherwise → writes `.gitwandrc` (JSONC-friendly default)
///
/// `content` MUST parse as JSON — comments aren't accepted on write
/// (we serialize from a structured object on the TS side). Validation
/// uses `serde_json::from_str` to fail loudly on malformed input rather
/// than silently corrupting the user's config file.
///
/// Path traversal: `cwd` is the repo root, the filename is hard-coded
/// here (`.gitwandrc` / `.gitwandrc.json`), so no user-supplied path
/// component reaches the filesystem.
#[tauri::command]
pub(crate) async fn write_gitwandrc(cwd: String, content: String) -> Result<(), String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }

    // Validate: must parse as JSON. We don't enforce schema here — the
    // structured object comes from the TS wrapper, this is a guard
    // against accidental corruption.
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("Invalid JSON for .gitwandrc: {}", e))?;

    let cwd_path = std::path::Path::new(&cwd);
    let rc_json = cwd_path.join(".gitwandrc.json");
    let rc_jsonc = cwd_path.join(".gitwandrc");

    // Mirror read_gitwandrc detection: if .gitwandrc.json exists, write
    // there; otherwise default to .gitwandrc (JSONC-friendly filename).
    let target = if rc_json.exists() { rc_json } else { rc_jsonc };

    std::fs::write(&target, &content)
        .map_err(|e| format!("Failed to write {}: {}", target.display(), e))
}

#[tauri::command]
pub(crate) async fn read_file_at_revision(
    cwd: String,
    rev: String,
    path: String,
) -> Result<FileAtRevision, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let mime = guess_mime_from_ext(&path).to_string();

    // Working tree read (rev empty) — go through the safe_repo_path helper.
    if rev.trim().is_empty() {
        let full = safe_repo_path(&cwd, &path)?;
        match std::fs::read(&full) {
            Ok(bytes) => Ok(FileAtRevision {
                byte_length: bytes.len(),
                bytes_base64: STANDARD.encode(&bytes),
                mime,
                absent: false,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileAtRevision {
                bytes_base64: String::new(),
                byte_length: 0,
                mime,
                absent: true,
            }),
            Err(e) => Err(format!("Failed to read {}: {}", path, e)),
        }
    } else {
        // Revision read — shell out to `git show <rev>:<path>`.
        // `current_dir(cwd)` keeps git confined to the repo.
        if cwd.trim().is_empty() {
            return Err("cwd must not be empty".to_string());
        }
        let spec = format!("{}:{}", rev, path);
        let output = git_cmd()
            .args(["show", &spec])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to run git show: {}", e))?;

        if !output.status.success() {
            // Missing file at that revision → treat as absent (not an error).
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("exists on disk, but not in")
                || stderr.contains("does not exist")
                || stderr.contains("unknown revision")
                || stderr.contains("Path")
            {
                return Ok(FileAtRevision {
                    bytes_base64: String::new(),
                    byte_length: 0,
                    mime,
                    absent: true,
                });
            }
            return Err(format!("git show {} failed: {}", spec, stderr.trim()));
        }

        Ok(FileAtRevision {
            byte_length: output.stdout.len(),
            bytes_base64: STANDARD.encode(&output.stdout),
            mime,
            absent: false,
        })
    }
}

#[tauri::command]
pub(crate) async fn folder_diff(
    cwd: String,
    ref_a: String,
    ref_b: String,
) -> Result<FolderDiffNode, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }

    let refs = folder_diff_args(&ref_a, &ref_b);

    // --- name-status (to recover the status letter + rename old path) ---
    let mut ns_args: Vec<String> = vec![
        "diff".to_string(),
        "-z".to_string(),
        "--name-status".to_string(),
        "--find-renames".to_string(),
    ];
    ns_args.extend(refs.iter().cloned());
    let ns_output = git_cmd()
        .args(&ns_args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git diff --name-status: {}", e))?;
    if !ns_output.status.success() {
        let stderr = String::from_utf8_lossy(&ns_output.stderr);
        return Err(format!("git diff --name-status failed: {}", stderr.trim()));
    }
    let ns_text = String::from_utf8_lossy(&ns_output.stdout).to_string();
    let name_status = parse_name_status_z(&ns_text);

    // --- numstat (to recover line counts + binary flag) ---
    let mut numstat_args: Vec<String> = vec![
        "diff".to_string(),
        "-z".to_string(),
        "--numstat".to_string(),
        "--find-renames".to_string(),
    ];
    numstat_args.extend(refs.iter().cloned());
    let ns2_output = git_cmd()
        .args(&numstat_args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git diff --numstat: {}", e))?;
    if !ns2_output.status.success() {
        let stderr = String::from_utf8_lossy(&ns2_output.stderr);
        return Err(format!("git diff --numstat failed: {}", stderr.trim()));
    }
    let numstat_text = String::from_utf8_lossy(&ns2_output.stdout).to_string();
    let numstat = parse_numstat_z(&numstat_text);

    // --- Merge into raw changes (key = new_path) ---
    let mut changes: Vec<RawFileChange> = Vec::with_capacity(name_status.len());
    for (new_path, status, old_path) in name_status.into_iter() {
        let (additions, deletions, binary) =
            numstat.get(&new_path).copied().unwrap_or((0, 0, false));
        changes.push(RawFileChange {
            new_path,
            old_path,
            status,
            additions,
            deletions,
            binary,
        });
    }

    // --- Build tree ---
    let mut root = FolderDiffNode {
        path: String::new(),
        name: String::new(),
        kind: "folder".to_string(),
        status: None,
        old_path: None,
        files_changed: 0,
        additions: 0,
        deletions: 0,
        binary: false,
        children: Vec::new(),
    };
    for change in changes.iter() {
        insert_change(&mut root, change);
    }
    sort_node(&mut root);
    Ok(root)
}

// ─── Directory listing (for FolderPicker) ──────────────────

#[tauri::command]
pub(crate) async fn list_dir(path: Option<String>) -> Result<ListDirResult, String> {
    let home_path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let home = home_path.to_string_lossy().to_string();

    let dir_path = match &path {
        Some(p) if !p.is_empty() => {
            let expanded = if p.starts_with('~') {
                p.replacen('~', &home, 1)
            } else {
                p.clone()
            };
            PathBuf::from(expanded)
        }
        _ => home_path.clone(),
    };

    let dir_path = dir_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    let entries =
        std::fs::read_dir(&dir_path).map_err(|e| format!("Cannot read directory: {}", e))?;

    // Is this the home directory? If so, we want to avoid probing
    // inside TCC-protected subfolders on macOS (Documents/Desktop/...)
    // because each probe triggers a system permission prompt.
    let at_home = home_path
        .canonicalize()
        .map(|h| h == dir_path)
        .unwrap_or(false);

    let mut dirs: Vec<DirEntry> = Vec::new();

    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden dirs (starting with .)
        if name.starts_with('.') {
            continue;
        }

        // Skip noisy directories
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }

        let full_path = entry.path();

        // Avoid probing `.git` inside TCC-protected folders at the home
        // level on macOS — it would trigger a permission dialog each time.
        let is_git_repo = if at_home && MACOS_TCC_PROTECTED.contains(&name.as_str()) {
            false
        } else {
            full_path.join(".git").exists()
        };

        dirs.push(DirEntry {
            name,
            path: full_path.to_string_lossy().to_string(),
            is_git_repo,
        });
    }

    dirs.sort_by_key(|a| a.name.to_lowercase());

    let parent = dir_path
        .parent()
        .filter(|p| *p != dir_path)
        .map(|p| p.to_string_lossy().to_string());

    Ok(ListDirResult {
        current: dir_path.to_string_lossy().to_string(),
        parent,
        home,
        dirs,
    })
}

// ─── Full repo file tree (File Explorer panel) ─────────────

/// Cap on total tree entries returned by `list_repo_tree` — see the
/// apps/desktop/CLAUDE.md P6.4 "IPC payloads > 1MB need truncation" rule.
/// 20k entries covers all but pathological monorepos while keeping the
/// payload small.
const MAX_REPO_TREE_ENTRIES: usize = 20_000;

/// Pure, synchronously-testable core of `list_repo_tree` (kept separate
/// from the `async fn` Tauri command so it can be unit-tested directly
/// without an async runtime).
fn build_repo_tree(cwd: &str) -> Result<RepoTreeResult, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }

    let output = git_cmd()
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git ls-files: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut paths: Vec<&str> = stdout.split('\0').filter(|p| !p.is_empty()).collect();
    paths.sort_unstable();

    let truncated = paths.len() > MAX_REPO_TREE_ENTRIES;
    if truncated {
        paths.truncate(MAX_REPO_TREE_ENTRIES);
    }

    let mut root = RepoTreeNode {
        path: String::new(),
        name: String::new(),
        kind: "folder".to_string(),
        children: Vec::new(),
    };
    for path in &paths {
        insert_repo_path(&mut root, path);
    }
    sort_repo_tree(&mut root);

    Ok(RepoTreeResult { root, truncated })
}

#[tauri::command]
pub(crate) async fn list_repo_tree(cwd: String) -> Result<RepoTreeResult, String> {
    build_repo_tree(&cwd)
}

// ─── One working-tree directory (Files view, v3.11.2) ──────

/// Per-directory cap for `list_repo_dir`, keeping the IPC payload well under
/// the 1 MB budget of apps/desktop/CLAUDE.md (P6.4). Mirrored by
/// `MAX_REPO_DIR_ENTRIES` in dev-server.mjs and `DIR_ENTRY_CAP` in
/// useLazyRepoTree.ts.
pub(crate) const MAX_REPO_DIR_ENTRIES: usize = 5_000;

struct RawDirEntry {
    name: String,
    kind: &'static str,
    size: u64,
}

/// Ignored means "matched by an ignore rule AND not tracked". libgit2's
/// `is_path_ignored` applies the rules without looking at the index, so a
/// force-added file, or a directory holding a tracked file, would otherwise
/// read as ignored. Measured against `git check-ignore` on 2026-10-01 (spec §4).
fn is_ignored_untracked(
    repo: &git2::Repository,
    index: &git2::Index,
    rel: &str,
    is_dir: bool,
) -> bool {
    if !repo.is_path_ignored(rel).unwrap_or(false) {
        return false;
    }
    if is_dir {
        index.find_prefix(format!("{}/", rel)).is_err()
    } else {
        index.get_path(std::path::Path::new(rel), 0).is_none()
    }
}

/// Pure, synchronously-testable core of `list_repo_dir`.
///
/// One level only (`read_dir`). `.git` is always skipped, symlinks are
/// reported as `symlink` and never followed, and names that are not UTF-8 are
/// skipped because no path built from them could round-trip through IPC.
/// Entries are sorted directories first, then case-insensitively by name,
/// *before* classification, so the cap keeps the same first 5,000 entries on
/// both backends and classification stops as soon as the cap is passed.
fn build_repo_dir_listing(
    cwd: &str,
    dir: &str,
    include_ignored: bool,
) -> Result<RepoDirListing, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    let dir = dir.trim_matches('/');
    if dir.split('/').any(|c| c == ".git") {
        return Err(format!("Refusing to list inside .git: {}", dir));
    }
    // `safe_repo_path` refuses an empty path; "." resolves to the canonical
    // repo root through the same checks.
    let resolved = safe_repo_path(cwd, if dir.is_empty() { "." } else { dir })?;
    if !resolved.is_dir() {
        return Err(if resolved.exists() {
            format!("Not a directory: {}", dir)
        } else {
            format!("Directory not found: {}", dir)
        });
    }
    let label = if dir.is_empty() { "." } else { dir };
    let read =
        std::fs::read_dir(&resolved).map_err(|e| format!("Failed to list {}: {}", label, e))?;

    let mut raw: Vec<RawDirEntry> = Vec::new();
    for entry in read.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == ".git" {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let (kind, size) = if ft.is_symlink() {
            ("symlink", 0)
        } else if ft.is_dir() {
            ("dir", 0)
        } else {
            ("file", entry.metadata().map(|m| m.len()).unwrap_or(0))
        };
        raw.push(RawDirEntry { name, kind, size });
    }
    raw.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    // Opened once per call: the repo for its ignore rules, the index for
    // "is this tracked?".
    let repo = git2::Repository::open(cwd).map_err(|e| format!("git2 open: {}", e))?;
    let index = repo.index().map_err(|e| format!("git2 index: {}", e))?;
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{}/", dir)
    };

    let mut entries: Vec<RepoDirEntry> = Vec::new();
    let mut truncated = false;
    for e in raw {
        let rel = format!("{}{}", prefix, e.name);
        let ignored = is_ignored_untracked(&repo, &index, &rel, e.kind == "dir");
        if ignored && !include_ignored {
            continue;
        }
        if entries.len() == MAX_REPO_DIR_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(RepoDirEntry {
            name: e.name,
            path: rel,
            kind: e.kind.to_string(),
            ignored,
            size: e.size,
        });
    }
    Ok(RepoDirListing { entries, truncated })
}

#[tauri::command]
pub(crate) async fn list_repo_dir(
    cwd: String,
    dir: String,
    include_ignored: bool,
) -> Result<RepoDirListing, String> {
    build_repo_dir_listing(&cwd, &dir, include_ignored)
}

#[cfg(test)]
mod list_repo_tree_tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    pub(super) struct TempRepo {
        pub(super) path: PathBuf,
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    impl TempRepo {
        pub(super) fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "gitwand-tree-test-{}-{}-{}-{}",
                label, pid, n, nanos
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.email", "test@gitwand.dev"]);
            repo.git(&["config", "user.name", "GitWand Test"]);
            repo
        }

        pub(super) fn cwd(&self) -> String {
            self.path.to_string_lossy().to_string()
        }

        pub(super) fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }

        pub(super) fn git(&self, args: &[&str]) {
            let status = StdCommand::new("git")
                .args(args)
                .current_dir(&self.path)
                .status()
                .unwrap();
            assert!(status.success(), "git {:?} failed", args);
        }
    }

    #[test]
    fn respects_gitignore_and_includes_untracked() {
        let repo = TempRepo::new("basic");
        repo.write(".gitignore", "ignored_dir/\n");
        repo.write("src/main.rs", "fn main() {}");
        repo.write("ignored_dir/secret.txt", "nope");
        repo.write("untracked.md", "# hi");
        repo.git(&["add", "src/main.rs", ".gitignore"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        let result = build_repo_tree(&repo.cwd()).unwrap();

        assert!(!result.truncated);
        let names: Vec<&str> = result
            .root
            .children
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"untracked.md"));
        assert!(names.contains(&".gitignore"));
        assert!(!names.contains(&"ignored_dir"));

        let src_folder = result
            .root
            .children
            .iter()
            .find(|c| c.name == "src")
            .unwrap();
        assert_eq!(src_folder.kind, "folder");
        assert_eq!(src_folder.children.len(), 1);
        assert_eq!(src_folder.children[0].name, "main.rs");
        assert_eq!(src_folder.children[0].path, "src/main.rs");
    }

    #[test]
    fn rejects_empty_cwd() {
        let err = build_repo_tree("").unwrap_err();
        assert!(err.contains("cwd must not be empty"));
    }
}

#[cfg(all(test, unix))]
mod write_file_tests {
    use super::list_repo_tree_tests::TempRepo;
    use super::*;

    fn write(repo: &TempRepo, path: &str) -> Result<(), String> {
        tauri::async_runtime::block_on(write_file(repo.cwd(), path.to_string(), "new".into()))
    }

    /// A sibling of the repo, removed on drop.
    struct Outside(PathBuf);
    impl Drop for Outside {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn outside(repo: &TempRepo) -> Outside {
        let mut name = repo.path.file_name().unwrap().to_os_string();
        name.push("-outside");
        let p = repo.path.parent().unwrap().join(name);
        std::fs::create_dir_all(&p).unwrap();
        Outside(p)
    }

    /// `cwd` itself must be a repository: `read_file("/", "etc/hosts")` used to
    /// read any file on the machine.
    #[test]
    fn refuses_a_cwd_outside_any_git_working_tree() {
        let repo = TempRepo::new("cwd-not-repo");
        let out = outside(&repo);
        std::fs::write(out.0.join("secret"), "s").unwrap();
        let cwd = out.0.to_string_lossy().into_owned();
        let read =
            tauri::async_runtime::block_on(read_file(cwd.clone(), "secret".into())).unwrap_err();
        assert!(read.contains("not inside a git working tree"), "{read}");
        let write =
            tauri::async_runtime::block_on(write_file(cwd, "w".into(), "x".into())).unwrap_err();
        assert!(write.contains("not inside a git working tree"), "{write}");
        assert!(!out.0.join("w").exists());

        // A subdirectory of a repository is inside its working tree.
        repo.write("sub/a.txt", "a");
        let sub = repo.path.join("sub").to_string_lossy().into_owned();
        assert_eq!(
            tauri::async_runtime::block_on(read_file(sub, "a.txt".into())).unwrap(),
            "a"
        );
    }

    /// Writing through a dangling symlink creates its target, wherever that
    /// is: this used to create a file outside the repository.
    #[test]
    fn refuses_a_dangling_leaf_symlink_and_creates_nothing() {
        let repo = TempRepo::new("write-dangling");
        let out = outside(&repo);
        let target = out.0.join("newfile");
        std::os::unix::fs::symlink(&target, repo.path.join("danglingleaf")).unwrap();
        let err = write(&repo, "danglingleaf").unwrap_err();
        assert!(
            err.starts_with("refusing to write through a symlink"),
            "{err}"
        );
        assert!(
            !target.exists(),
            "write_file created a file outside the repo"
        );

        let inside = repo.path.join("missing-in-repo");
        std::os::unix::fs::symlink(&inside, repo.path.join("dangling-in")).unwrap();
        assert!(write(&repo, "dangling-in").is_err());
        assert!(!inside.exists());
    }

    #[test]
    fn refuses_a_symlink_pointing_outside() {
        let repo = TempRepo::new("write-out");
        let out = outside(&repo);
        std::fs::write(out.0.join("f"), "orig").unwrap();
        std::os::unix::fs::symlink(out.0.join("f"), repo.path.join("link")).unwrap();
        assert!(write(&repo, "link").is_err());
        assert_eq!(std::fs::read_to_string(out.0.join("f")).unwrap(), "orig");
    }

    #[test]
    fn still_writes_plain_new_and_in_repo_symlinked_files() {
        let repo = TempRepo::new("write-ok");
        repo.write("a.txt", "old");
        write(&repo, "a.txt").expect("plain file");
        assert_eq!(
            std::fs::read_to_string(repo.path.join("a.txt")).unwrap(),
            "new"
        );
        write(&repo, "brand-new.txt").expect("new file");
        assert_eq!(
            std::fs::read_to_string(repo.path.join("brand-new.txt")).unwrap(),
            "new"
        );
        repo.write("t.txt", "old");
        std::os::unix::fs::symlink(repo.path.join("t.txt"), repo.path.join("l.txt")).unwrap();
        write(&repo, "l.txt").expect("in-repo symlink");
        assert_eq!(
            std::fs::read_to_string(repo.path.join("t.txt")).unwrap(),
            "new"
        );
    }
}

#[cfg(test)]
mod list_repo_dir_tests {
    use super::list_repo_tree_tests::TempRepo;
    use super::*;
    use crate::types::{RepoDirEntry, RepoDirListing};

    /// A repo whose ignore rules come only from its own `.gitignore`: the
    /// developer's global excludes file must not leak into the assertions.
    /// The path does not need to exist; git and libgit2 skip a missing one.
    fn hermetic(label: &str) -> TempRepo {
        let repo = TempRepo::new(label);
        let none = repo.path.join(".git").join("no-global-excludes");
        repo.git(&["config", "core.excludesFile", &none.to_string_lossy()]);
        repo
    }

    fn names(l: &RepoDirListing) -> Vec<&str> {
        l.entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn entry<'a>(l: &'a RepoDirListing, name: &str) -> &'a RepoDirEntry {
        l.entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("no entry {name} in {:?}", names(l)))
    }

    #[test]
    fn lists_one_level_sorted_dirs_first_case_insensitively() {
        let repo = hermetic("sort");
        repo.write("src/main.rs", "fn main() {}");
        repo.write("alpha.md", "a");
        repo.write("Beta.txt", "b");
        repo.write("zeta.txt", "z");
        repo.write("Docs/readme.md", "d");
        repo.git(&["add", "alpha.md", "src/main.rs"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        let l = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(
            names(&l),
            vec!["Docs", "src", "alpha.md", "Beta.txt", "zeta.txt"]
        );
        assert!(!l.truncated);
        let src = entry(&l, "src");
        assert_eq!(
            (src.kind.as_str(), src.path.as_str(), src.size),
            ("dir", "src", 0)
        );
        let alpha = entry(&l, "alpha.md");
        assert_eq!(
            (alpha.kind.as_str(), alpha.size, alpha.ignored),
            ("file", 1, false)
        );
        // Untracked and not ignored.
        assert!(!entry(&l, "Beta.txt").ignored);
        // One level only: nothing from inside src/ or Docs/.
        assert!(l.entries.iter().all(|e| !e.path.contains('/')));
    }

    #[test]
    fn lists_a_subdirectory_with_repo_relative_paths() {
        let repo = hermetic("subdir");
        repo.write("src/lib/a.rs", "");
        repo.write("src/b.rs", "");
        let l = build_repo_dir_listing(&repo.cwd(), "src", false).unwrap();
        assert_eq!(names(&l), vec!["lib", "b.rs"]);
        assert_eq!(entry(&l, "lib").path, "src/lib");
        assert_eq!(entry(&l, "b.rs").path, "src/b.rs");
        // A trailing slash names the same directory.
        let slashed = build_repo_dir_listing(&repo.cwd(), "src/", false).unwrap();
        assert_eq!(slashed.entries, l.entries);
    }

    #[test]
    fn ignored_entries_are_dropped_unless_requested() {
        let repo = hermetic("ignored");
        repo.write(".gitignore", "node_modules/\n*.log\n");
        repo.write("node_modules/pkg/index.js", "");
        repo.write("debug.log", "x");
        repo.write("notes.txt", "n");
        repo.git(&["add", ".gitignore"]);
        repo.git(&["commit", "-q", "-m", "ignore"]);

        let hidden = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&hidden), vec![".gitignore", "notes.txt"]);

        let shown = build_repo_dir_listing(&repo.cwd(), "", true).unwrap();
        assert_eq!(
            names(&shown),
            vec!["node_modules", ".gitignore", "debug.log", "notes.txt"]
        );
        assert!(entry(&shown, "node_modules").ignored);
        assert!(entry(&shown, "debug.log").ignored);
        assert!(!entry(&shown, "notes.txt").ignored);

        // Inside an ignored directory every untracked entry is ignored.
        let inside = build_repo_dir_listing(&repo.cwd(), "node_modules", true).unwrap();
        assert_eq!(names(&inside), vec!["pkg"]);
        assert!(entry(&inside, "pkg").ignored);
        assert!(build_repo_dir_listing(&repo.cwd(), "node_modules", false)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn tracked_paths_under_ignore_rules_are_not_ignored() {
        let repo = hermetic("tracked-ignored");
        // Committed before the rule exists: a build output checked in on purpose.
        repo.write("build/keep.txt", "k");
        repo.git(&["add", "build/keep.txt"]);
        repo.git(&["commit", "-q", "-m", "keep"]);
        repo.write(".gitignore", "build/\n*.log\n");
        repo.write("build/out.bin", "o");
        repo.write("forced.log", "f");
        repo.git(&["add", ".gitignore"]);
        repo.git(&["add", "-f", "forced.log"]);
        repo.git(&["commit", "-q", "-m", "rules"]);

        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert!(
            !entry(&root, "build").ignored,
            "a directory holding a tracked file is not ignored"
        );
        assert!(
            !entry(&root, "forced.log").ignored,
            "a force-added file is not ignored"
        );

        let build = build_repo_dir_listing(&repo.cwd(), "build", true).unwrap();
        assert!(!entry(&build, "keep.txt").ignored);
        assert!(entry(&build, "out.bin").ignored);
        assert_eq!(
            names(&build_repo_dir_listing(&repo.cwd(), "build", false).unwrap()),
            vec!["keep.txt"]
        );
    }

    #[test]
    fn git_dir_is_never_listed() {
        let repo = hermetic("gitdir");
        repo.write("a.txt", "");
        let root = build_repo_dir_listing(&repo.cwd(), "", true).unwrap();
        assert!(!names(&root).contains(&".git"));
        assert_eq!(
            build_repo_dir_listing(&repo.cwd(), ".git", true).unwrap_err(),
            "Refusing to list inside .git: .git"
        );
        let err = build_repo_dir_listing(&repo.cwd(), ".git/refs", true).unwrap_err();
        assert!(err.starts_with("Refusing to list inside .git"), "{err}");
    }

    #[test]
    fn a_nested_repository_is_a_plain_directory_whose_git_dir_is_skipped() {
        let repo = hermetic("nested");
        repo.write("nested/inner.txt", "i");
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path.join("nested"))
            .status()
            .unwrap();
        assert!(status.success());

        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        let nested = entry(&root, "nested");
        assert_eq!((nested.kind.as_str(), nested.ignored), ("dir", false));
        let inside = build_repo_dir_listing(&repo.cwd(), "nested", false).unwrap();
        assert_eq!(names(&inside), vec!["inner.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_reported_and_never_followed() {
        let repo = hermetic("symlink");
        repo.write("real/file.txt", "r");
        std::os::unix::fs::symlink(repo.path.join("real"), repo.path.join("link-in")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), repo.path.join("link-out")).unwrap();

        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&root), vec!["real", "link-in", "link-out"]);
        for n in ["link-in", "link-out"] {
            let e = entry(&root, n);
            assert_eq!((e.kind.as_str(), e.size), ("symlink", 0), "{n}");
        }
        let err = build_repo_dir_listing(&repo.cwd(), "link-out", false).unwrap_err();
        assert!(err.contains("path escapes cwd"), "{err}");
    }

    #[test]
    fn caps_a_directory_at_5000_entries() {
        let repo = hermetic("cap");
        let big = repo.path.join("big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..=MAX_REPO_DIR_ENTRIES {
            std::fs::write(big.join(format!("f{:05}.txt", i)), "").unwrap();
        }
        let l = build_repo_dir_listing(&repo.cwd(), "big", false).unwrap();
        assert!(l.truncated);
        assert_eq!(l.entries.len(), MAX_REPO_DIR_ENTRIES);
        assert_eq!(l.entries.last().unwrap().name, "f04999.txt");

        std::fs::remove_file(big.join("f05000.txt")).unwrap();
        let exact = build_repo_dir_listing(&repo.cwd(), "big", false).unwrap();
        assert!(!exact.truncated, "exactly 5,000 entries is not truncated");
        assert_eq!(exact.entries.len(), MAX_REPO_DIR_ENTRIES);
    }

    #[test]
    fn refuses_paths_that_escape_the_repo() {
        let repo = hermetic("escape");
        repo.write("src/a.rs", "");
        for dir in ["..", "../..", "src/../.."] {
            let err = build_repo_dir_listing(&repo.cwd(), dir, false).unwrap_err();
            assert!(err.contains("path escapes cwd"), "{dir}: {err}");
        }
    }

    #[test]
    fn a_missing_directory_or_a_file_is_reported_plainly() {
        let repo = hermetic("missing");
        repo.write("a.txt", "");
        assert_eq!(
            build_repo_dir_listing(&repo.cwd(), "gone", false).unwrap_err(),
            "Directory not found: gone"
        );
        assert_eq!(
            build_repo_dir_listing(&repo.cwd(), "a.txt", false).unwrap_err(),
            "Not a directory: a.txt"
        );
    }

    #[test]
    fn names_with_spaces_and_unicode_round_trip() {
        let repo = hermetic("space é");
        repo.write("docs/guide one.md", "g");
        repo.write("café.txt", "c");
        let root = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&root), vec!["docs", "café.txt"]);
        let docs = build_repo_dir_listing(&repo.cwd(), "docs", false).unwrap();
        assert_eq!(entry(&docs, "guide one.md").path, "docs/guide one.md");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn names_that_are_not_utf8_are_skipped() {
        use std::os::unix::ffi::OsStrExt;
        let repo = hermetic("non-utf8");
        repo.write("ok.txt", "");
        let bad = std::ffi::OsStr::from_bytes(b"bad\xff.txt");
        std::fs::write(repo.path.join(bad), "").unwrap();
        let l = build_repo_dir_listing(&repo.cwd(), "", false).unwrap();
        assert_eq!(names(&l), vec!["ok.txt"]);
    }

    #[test]
    fn rejects_empty_cwd() {
        assert_eq!(
            build_repo_dir_listing("", "", false).unwrap_err(),
            "cwd must not be empty"
        );
    }

    /// Perf sanity, not a benchmark. Run with
    /// `cargo test list_repo_dir_perf -- --ignored`. The spec measured 66 ms in
    /// release for this shape; the bound is 15x that, so neither a debug build
    /// nor a loaded CI box can flake it.
    #[test]
    #[ignore = "perf sanity: run explicitly with --ignored"]
    fn list_repo_dir_perf_6000_files_under_one_second() {
        let repo = hermetic("perf");
        repo.write(".gitignore", "*.tmp\n");
        let big = repo.path.join("big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..6_000 {
            let ext = if i % 3 == 0 { "tmp" } else { "txt" };
            std::fs::write(big.join(format!("f{:05}.{}", i, ext)), "").unwrap();
        }
        let start = std::time::Instant::now();
        let l = build_repo_dir_listing(&repo.cwd(), "big", true).unwrap();
        let elapsed = start.elapsed();
        assert!(l.truncated);
        assert_eq!(l.entries.len(), MAX_REPO_DIR_ENTRIES);
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "listing took {elapsed:?}"
        );
    }
}

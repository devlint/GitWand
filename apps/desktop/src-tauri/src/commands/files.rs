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
//!
//! All helpers used here (safe_repo_path, git_cmd, parse_name_status_z,
//! parse_numstat_z, folder_diff_args, insert_change, sort_node,
//! guess_mime_from_ext) live in `crate::git::*` (parse.rs / cmd.rs).

use crate::git::*;
use crate::types::*;
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn read_file(cwd: String, path: String) -> Result<String, String> {
    let full = safe_repo_path(&cwd, &path)?;
    std::fs::read_to_string(&full).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub(crate) fn write_file(cwd: String, path: String, content: String) -> Result<(), String> {
    let full = safe_repo_path(&cwd, &path)?;
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
pub(crate) fn write_gitwandrc(cwd: String, content: String) -> Result<(), String> {
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
pub(crate) fn read_file_at_revision(
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
pub(crate) fn folder_diff(cwd: String, ref_a: String, ref_b: String) -> Result<FolderDiffNode, String> {
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
        let (additions, deletions, binary) = numstat
            .get(&new_path)
            .copied()
            .unwrap_or((0, 0, false));
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
pub(crate) fn list_dir(path: Option<String>) -> Result<ListDirResult, String> {
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

    let entries = std::fs::read_dir(&dir_path)
        .map_err(|e| format!("Cannot read directory: {}", e))?;

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

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

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

use serde::Serialize;
use std::path::{Path, PathBuf};

/// GitWand Desktop — Tauri backend
///
/// Most of the resolution logic runs in the frontend via @gitwand/core (TypeScript).
/// This Rust backend handles:
/// - Native file system access (reading conflicted files, browsing directories)
/// - Git command execution
/// - Window management

// ─── Git commands ──────────────────────────────────────────

#[tauri::command]
fn get_conflicted_files(cwd: String) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<String> = stdout
        .trim()
        .split('\n')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(files)
}

// ─── Git status ───────────────────────────────────────────

#[derive(Serialize)]
struct FileChange {
    path: String,
    status: String, // "added", "modified", "deleted", "renamed"
    old_path: Option<String>,
}

#[derive(Serialize)]
struct GitStatus {
    branch: String,
    remote: Option<String>,
    ahead: i32,
    behind: i32,
    staged: Vec<FileChange>,
    unstaged: Vec<FileChange>,
    untracked: Vec<String>,
    conflicted: Vec<String>,
}

#[tauri::command]
fn git_status(cwd: String) -> Result<GitStatus, String> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain=v2", "--branch"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        return Err("git status failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = String::from("unknown");
    let mut remote: Option<String> = None;
    let mut ahead: i32 = 0;
    let mut behind: i32 = 0;
    let mut staged: Vec<FileChange> = Vec::new();
    let mut unstaged: Vec<FileChange> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut conflicted: Vec<String> = Vec::new();

    for line in stdout.lines() {
        if line.starts_with("# branch.head ") {
            branch = line.strip_prefix("# branch.head ").unwrap_or("unknown").to_string();
        } else if line.starts_with("# branch.ab ") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                ahead = parts[2].strip_prefix('+').unwrap_or("0").parse().unwrap_or(0);
                behind = parts[3].strip_prefix('-').unwrap_or("0").parse().unwrap_or(0);
            }
        } else if line.starts_with("# branch.oid ") {
            // track oid if needed
        } else if line.starts_with("# branch.upstream ") {
            remote = Some(line.strip_prefix("# branch.upstream ").unwrap_or("").to_string());
        } else if line.starts_with("u ") {
            // unmerged (conflicted)
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                conflicted.push(parts[1].to_string());
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // regular file
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                continue;
            }
            let path = parts[1].to_string();
            let meta_parts: Vec<&str> = parts[0].split_whitespace().collect();
            if meta_parts.len() < 2 {
                continue;
            }

            // Format: "1 <xy> ..." where x is staged, y is unstaged
            let xy = meta_parts[1];
            if xy.len() < 2 {
                continue;
            }

            let staged_char = xy.chars().next().unwrap();
            let unstaged_char = xy.chars().nth(1).unwrap();

            // Staged changes
            if staged_char != '.' {
                let status = match staged_char {
                    'A' => "added",
                    'M' => "modified",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                }
                .to_string();
                staged.push(FileChange {
                    path: path.clone(),
                    status,
                    old_path: None,
                });
            }

            // Unstaged changes
            if unstaged_char != '.' {
                let status = match unstaged_char {
                    'M' => "modified",
                    'D' => "deleted",
                    _ => "modified",
                }
                .to_string();
                unstaged.push(FileChange {
                    path,
                    status,
                    old_path: None,
                });
            }
        } else if line.starts_with("? ") {
            // untracked
            let path = line.strip_prefix("? ").unwrap_or("").to_string();
            if !path.is_empty() {
                untracked.push(path);
            }
        }
    }

    // If upstream exists but ahead/behind are 0, try rev-list as fallback
    if remote.is_some() && ahead == 0 && behind == 0 {
        if let Ok(rev_output) = std::process::Command::new("git")
            .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
            .current_dir(&cwd)
            .output()
        {
            if rev_output.status.success() {
                let rev_str = String::from_utf8_lossy(&rev_output.stdout);
                let nums: Vec<i32> = rev_str
                    .trim()
                    .split_whitespace()
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if nums.len() >= 2 {
                    ahead = nums[0];
                    behind = nums[1];
                }
            }
        }
    }

    Ok(GitStatus {
        branch,
        remote,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
    })
}

// ─── Git diff ──────────────────────────────────────────────

#[derive(Serialize)]
struct DiffLine {
    r#type: String, // "context", "add", "delete"
    content: String,
    old_line_no: Option<i32>,
    new_line_no: Option<i32>,
}

#[derive(Serialize)]
struct DiffHunk {
    header: String,
    old_start: i32,
    old_count: i32,
    new_start: i32,
    new_count: i32,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
struct GitDiff {
    path: String,
    hunks: Vec<DiffHunk>,
}

#[tauri::command]
fn git_diff(cwd: String, path: String, staged: bool) -> Result<GitDiff, String> {
    let mut cmd = std::process::Command::new("git");
    if staged {
        cmd.arg("diff").arg("--cached");
    } else {
        cmd.arg("diff");
    }
    cmd.arg("--").arg(&path).current_dir(&cwd);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut hunks: Vec<DiffHunk> = Vec::new();

    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line_no = 0;
    let mut new_line_no = 0;

    for line in stdout.lines() {
        if line.starts_with("@@") {
            // Save previous hunk if exists
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            // Parse hunk header
            let header = line.to_string();
            // Parse @@ -oldStart,oldCount +newStart,newCount @@
            let parts: Vec<&str> = line.split_whitespace().collect();
            let mut old_start = 0;
            let mut old_count = 1;
            let mut new_start = 0;
            let mut new_count = 1;

            if parts.len() >= 3 {
                let old_range = parts[1].strip_prefix('-').unwrap_or("0");
                let new_range = parts[2].strip_prefix('+').unwrap_or("0");

                if let Some(comma_idx) = old_range.find(',') {
                    old_start = old_range[..comma_idx].parse().unwrap_or(0);
                    old_count = old_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    old_start = old_range.parse().unwrap_or(0);
                }

                if let Some(comma_idx) = new_range.find(',') {
                    new_start = new_range[..comma_idx].parse().unwrap_or(0);
                    new_count = new_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    new_start = new_range.parse().unwrap_or(0);
                }
            }

            old_line_no = old_start;
            new_line_no = new_start;

            current_hunk = Some(DiffHunk {
                header,
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
            });
        } else if let Some(ref mut hunk) = current_hunk {
            if line.starts_with('+') && !line.starts_with("+++") {
                hunk.lines.push(DiffLine {
                    r#type: "add".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: None,
                    new_line_no: Some(new_line_no),
                });
                new_line_no += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                hunk.lines.push(DiffLine {
                    r#type: "delete".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: Some(old_line_no),
                    new_line_no: None,
                });
                old_line_no += 1;
            } else if !line.starts_with('\\') {
                // context line
                let content = if line.is_empty() {
                    "".to_string()
                } else {
                    line[1..].to_string()
                };
                hunk.lines.push(DiffLine {
                    r#type: "context".to_string(),
                    content,
                    old_line_no: Some(old_line_no),
                    new_line_no: Some(new_line_no),
                });
                old_line_no += 1;
                new_line_no += 1;
            }
        }
    }

    // Save last hunk
    if let Some(hunk) = current_hunk.take() {
        hunks.push(hunk);
    }

    Ok(GitDiff {
        path,
        hunks,
    })
}

// ─── Git log ───────────────────────────────────────────────

#[derive(Serialize)]
struct GitLogEntry {
    hash: String,
    hash_full: String,
    author: String,
    email: String,
    date: String,
    message: String,
    body: String,
}

#[tauri::command]
fn git_log(cwd: String, count: Option<i32>) -> Result<Vec<GitLogEntry>, String> {
    let limit = count.unwrap_or(50);

    // Use unit separator (ASCII 0x1f) to delimit fields
    let format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";

    let output = std::process::Command::new("git")
        .args([
            "log",
            &format!("-n{}", limit),
            &format!("--format={}", format),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    if !output.status.success() {
        return Err("git log failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<GitLogEntry> = Vec::new();

    // Split by record separator (0x1e)
    for record in stdout.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }

        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() < 7 {
            continue;
        }

        entries.push(GitLogEntry {
            hash: fields[0].to_string(),
            hash_full: fields[1].to_string(),
            author: fields[2].to_string(),
            email: fields[3].to_string(),
            date: fields[4].to_string(),
            message: fields[5].to_string(),
            body: fields[6].trim().to_string(),
        });
    }

    Ok(entries)
}

// ─── File system commands ──────────────────────────────────

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

// ─── Directory listing (for FolderPicker) ──────────────────

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_git_repo: bool,
}

#[derive(Serialize)]
struct ListDirResult {
    current: String,
    parent: Option<String>,
    home: String,
    dirs: Vec<DirEntry>,
}

/// Hidden directories to skip (except .git which we detect)
const HIDDEN_EXCEPTIONS: &[&str] = &[];
const SKIP_DIRS: &[&str] = &["node_modules", "__pycache__", ".Trash", "target"];

#[tauri::command]
fn list_dir(path: Option<String>) -> Result<ListDirResult, String> {
    let home = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .to_string_lossy()
        .to_string();

    let dir_path = match &path {
        Some(p) if !p.is_empty() => {
            let expanded = if p.starts_with('~') {
                p.replacen('~', &home, 1)
            } else {
                p.clone()
            };
            PathBuf::from(expanded)
        }
        _ => PathBuf::from(&home),
    };

    let dir_path = dir_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    let entries = std::fs::read_dir(&dir_path)
        .map_err(|e| format!("Cannot read directory: {}", e))?;

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
        let is_git_repo = full_path.join(".git").exists();

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

// ─── Git stage / unstage ─────────────────────────────────────

#[tauri::command]
fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("add").arg("--").current_dir(&cwd);
    for p in &paths {
        cmd.arg(p);
    }
    let output = cmd.output().map_err(|e| format!("Failed to run git add: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("reset").arg("HEAD").arg("--").current_dir(&cwd);
    for p in &paths {
        cmd.arg(p);
    }
    let output = cmd.output().map_err(|e| format!("Failed to run git reset: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git reset failed: {}", stderr));
    }
    Ok(())
}

// ─── Git commit ──────────────────────────────────────────────

#[tauri::command]
fn git_commit(cwd: String, message: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {}", stderr));
    }

    // Return the new commit hash
    let log_output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    let hash = String::from_utf8_lossy(&log_output.stdout).trim().to_string();
    Ok(hash)
}

// ─── Git push / pull ─────────────────────────────────────────

#[derive(Serialize)]
struct GitPushPullResult {
    success: bool,
    message: String,
}

#[tauri::command]
fn git_push(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new("git")
        .args(["push"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        },
    })
}

#[tauri::command]
fn git_fetch(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new("git")
        .args(["fetch", "--prune"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git fetch: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        },
    })
}

#[tauri::command]
fn git_pull(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new("git")
        .args(["pull"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git pull: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        },
    })
}

// ─── Git discard changes ─────────────────────────────────────

#[tauri::command]
fn git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    // Restore tracked files
    let mut cmd = std::process::Command::new("git");
    cmd.arg("checkout").arg("--").current_dir(&cwd);
    for p in &paths {
        cmd.arg(p);
    }
    let output = cmd.output().map_err(|e| format!("Failed to run git checkout: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git checkout failed: {}", stderr));
    }
    Ok(())
}

// ─── Git show (commit diff) ──────────────────────────────────

#[tauri::command]
fn git_show(cwd: String, hash: String) -> Result<Vec<GitDiff>, String> {
    let output = std::process::Command::new("git")
        .args(["show", "--format=", &hash])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git show: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut diffs: Vec<GitDiff> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line_no = 0;
    let mut new_line_no = 0;
    let mut current_hunks: Vec<DiffHunk> = Vec::new();

    for line in stdout.lines() {
        if line.starts_with("diff --git ") {
            // Save previous file diff
            if let Some(hunk) = current_hunk.take() {
                current_hunks.push(hunk);
            }
            if let Some(path) = current_path.take() {
                diffs.push(GitDiff {
                    path,
                    hunks: std::mem::take(&mut current_hunks),
                });
            }

            // Extract file path from "diff --git a/path b/path"
            let parts: Vec<&str> = line.split(" b/").collect();
            if parts.len() >= 2 {
                current_path = Some(parts[1].to_string());
            }
        } else if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                current_hunks.push(hunk);
            }

            let header = line.to_string();
            let parts: Vec<&str> = line.split_whitespace().collect();
            let mut old_start = 0;
            let mut old_count = 1;
            let mut new_start = 0;
            let mut new_count = 1;

            if parts.len() >= 3 {
                let old_range = parts[1].strip_prefix('-').unwrap_or("0");
                let new_range = parts[2].strip_prefix('+').unwrap_or("0");

                if let Some(comma_idx) = old_range.find(',') {
                    old_start = old_range[..comma_idx].parse().unwrap_or(0);
                    old_count = old_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    old_start = old_range.parse().unwrap_or(0);
                }

                if let Some(comma_idx) = new_range.find(',') {
                    new_start = new_range[..comma_idx].parse().unwrap_or(0);
                    new_count = new_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    new_start = new_range.parse().unwrap_or(0);
                }
            }

            old_line_no = old_start;
            new_line_no = new_start;

            current_hunk = Some(DiffHunk {
                header,
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
            });
        } else if let Some(ref mut hunk) = current_hunk {
            if line.starts_with('+') && !line.starts_with("+++") {
                hunk.lines.push(DiffLine {
                    r#type: "add".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: None,
                    new_line_no: Some(new_line_no),
                });
                new_line_no += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                hunk.lines.push(DiffLine {
                    r#type: "delete".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: Some(old_line_no),
                    new_line_no: None,
                });
                old_line_no += 1;
            } else if !line.starts_with('\\') {
                let content = if line.is_empty() {
                    "".to_string()
                } else {
                    line[1..].to_string()
                };
                hunk.lines.push(DiffLine {
                    r#type: "context".to_string(),
                    content,
                    old_line_no: Some(old_line_no),
                    new_line_no: Some(new_line_no),
                });
                old_line_no += 1;
                new_line_no += 1;
            }
        }
    }

    // Save last file diff
    if let Some(hunk) = current_hunk.take() {
        current_hunks.push(hunk);
    }
    if let Some(path) = current_path.take() {
        diffs.push(GitDiff {
            path,
            hunks: current_hunks,
        });
    }

    Ok(diffs)
}

// ─── Git branches ────────────────────────────────────────────

#[derive(Serialize)]
struct GitBranch {
    name: String,
    is_current: bool,
    is_remote: bool,
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
    last_commit: String,
}

#[tauri::command]
fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    // Use git branch -a --format to get structured output
    let output = std::process::Command::new("git")
        .args([
            "branch", "-a",
            "--format=%(HEAD)%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(objectname:short) %(subject)",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches: Vec<GitBranch> = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        let is_current = line.starts_with('*');
        let line = if is_current { &line[1..] } else { line };

        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 3 { continue; }

        let name = parts[0].to_string();
        let upstream = if parts[1].is_empty() { None } else { Some(parts[1].to_string()) };
        let track_info = parts[2];

        // Parse ahead/behind from track info like "ahead 2, behind 1"
        let mut ahead: i32 = 0;
        let mut behind: i32 = 0;
        if !track_info.is_empty() {
            for part in track_info.split(", ") {
                if part.starts_with("ahead ") {
                    ahead = part.strip_prefix("ahead ").unwrap_or("0").parse().unwrap_or(0);
                } else if part.starts_with("behind ") {
                    behind = part.strip_prefix("behind ").unwrap_or("0").parse().unwrap_or(0);
                }
            }
        }

        let last_commit = if parts.len() > 3 { parts[3].to_string() } else { String::new() };

        // Skip HEAD -> origin/main style remote refs
        if name.contains("HEAD ->") || name == "origin/HEAD" { continue; }

        let is_remote = name.starts_with("origin/") || name.starts_with("remotes/");

        branches.push(GitBranch {
            name,
            is_current,
            is_remote,
            upstream,
            ahead,
            behind,
            last_commit,
        });
    }

    Ok(branches)
}

#[tauri::command]
fn git_create_branch(cwd: String, name: String, checkout: bool) -> Result<(), String> {
    if checkout {
        let output = std::process::Command::new("git")
            .args(["checkout", "-b", &name])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout -b failed: {}", stderr));
        }
    } else {
        let output = std::process::Command::new("git")
            .args(["branch", &name])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git branch failed: {}", stderr));
        }
    }
    Ok(())
}

#[tauri::command]
fn git_switch_branch(cwd: String, name: String) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args(["checkout", &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to switch branch: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git checkout failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<(), String> {
    let flag = if force { "-D" } else { "-d" };
    let output = std::process::Command::new("git")
        .args(["branch", flag, &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete branch: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch {} failed: {}", flag, stderr));
    }
    Ok(())
}

// ─── Tauri entry point ─────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_conflicted_files,
            read_file,
            write_file,
            list_dir,
            git_status,
            git_diff,
            git_log,
            git_stage,
            git_unstage,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_discard,
            git_show,
            git_branches,
            git_create_branch,
            git_switch_branch,
            git_delete_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitWand");
}

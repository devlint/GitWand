use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// GitWand Desktop — Tauri backend
///
/// Most of the resolution logic runs in the frontend via @gitwand/core (TypeScript).
/// This Rust backend handles:
/// - Native file system access (reading conflicted files, browsing directories)
/// - Git command execution
/// - Window management

// ─── Configurable git binary ──────────────────────────────
//
// Defaults to "git" (resolved from PATH).
// Updated at runtime via the `set_git_config` Tauri command when the user
// sets a custom git path in Settings.

static GIT_BINARY: OnceLock<Mutex<String>> = OnceLock::new();

fn git_binary() -> String {
    GIT_BINARY
        .get_or_init(|| Mutex::new("git".to_string()))
        .lock()
        .unwrap()
        .clone()
}

#[tauri::command]
fn set_git_config(git_path: String) -> Result<(), String> {
    let mut binary = GIT_BINARY
        .get_or_init(|| Mutex::new("git".to_string()))
        .lock()
        .unwrap();
    *binary = if git_path.trim().is_empty() {
        "git".to_string()
    } else {
        git_path.trim().to_string()
    };
    Ok(())
}

// ─── Git commands ──────────────────────────────────────────

#[tauri::command]
fn get_conflicted_files(cwd: String) -> Result<Vec<String>, String> {
    let output = std::process::Command::new(git_binary())
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
    let output = std::process::Command::new(git_binary())
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
            // unmerged (conflicted) — porcelain v2 format:
            // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            // All fields separated by spaces (no tabs)
            let parts: Vec<&str> = line.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                conflicted.push(parts[10].to_string());
            }
        } else if line.starts_with("1 ") {
            // ordinary changed entry — porcelain v2 format:
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // All fields separated by spaces (no tabs)
            let fields: Vec<&str> = line.splitn(9, ' ').collect();
            if fields.len() < 9 {
                continue;
            }
            let xy = fields[1];
            let path = fields[8].to_string();

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
        } else if line.starts_with("2 ") {
            // renamed/copied entry — porcelain v2 format:
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
            // Fields separated by spaces, but path and origPath separated by tab
            let tab_idx = line.find('\t');
            let meta_part = if let Some(idx) = tab_idx { &line[..idx] } else { line };
            let fields: Vec<&str> = meta_part.split_whitespace().collect();
            if fields.len() < 10 {
                continue;
            }
            let xy = fields[1];
            let path = fields[9].to_string();
            let old_path = tab_idx.map(|idx| line[idx + 1..].to_string());

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
                    old_path: old_path.clone(),
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
                    old_path,
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
        if let Ok(rev_output) = std::process::Command::new(git_binary())
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
    let mut cmd = std::process::Command::new(git_binary());
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
    parents: Vec<String>,
    refs: String,
}

#[tauri::command]
fn git_log(cwd: String, count: Option<i32>) -> Result<Vec<GitLogEntry>, String> {
    let limit = count.unwrap_or(50);

    // Use unit separator (ASCII 0x1f) to delimit fields
    let format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";

    let output = std::process::Command::new(git_binary())
        .args([
            "log",
            "--all",
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
        if fields.len() < 9 {
            continue;
        }

        let parents: Vec<String> = fields[7]
            .trim()
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        entries.push(GitLogEntry {
            hash: fields[0].to_string(),
            hash_full: fields[1].to_string(),
            author: fields[2].to_string(),
            email: fields[3].to_string(),
            date: fields[4].to_string(),
            message: fields[5].to_string(),
            body: fields[6].trim().to_string(),
            parents,
            refs: fields[8].trim().to_string(),
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
    let mut cmd = std::process::Command::new(git_binary());
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
    let mut cmd = std::process::Command::new(git_binary());
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

#[tauri::command]
fn git_stage_patch(cwd: String, patch: String) -> Result<(), String> {
    let mut cmd = std::process::Command::new(git_binary());
    cmd.args(["apply", "--cached", "--unidiff-zero", "-"])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to run git apply: {}", e))?;
    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        stdin.write_all(patch.as_bytes()).map_err(|e| format!("Failed to write patch: {}", e))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("Failed to wait for git apply: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
fn git_unstage_patch(cwd: String, patch: String) -> Result<(), String> {
    let mut cmd = std::process::Command::new(git_binary());
    cmd.args(["apply", "--cached", "--reverse", "--unidiff-zero", "-"])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to run git apply: {}", e))?;
    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        stdin.write_all(patch.as_bytes()).map_err(|e| format!("Failed to write patch: {}", e))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("Failed to wait for git apply: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply --reverse failed: {}", stderr));
    }
    Ok(())
}

// ─── Git commit ──────────────────────────────────────────────

#[tauri::command]
fn git_commit(cwd: String, message: String) -> Result<String, String> {
    let output = std::process::Command::new(git_binary())
        .args(["commit", "-m", &message])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {}", stderr));
    }

    // Return the new commit hash
    let log_output = std::process::Command::new(git_binary())
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    let hash = String::from_utf8_lossy(&log_output.stdout).trim().to_string();
    Ok(hash)
}

#[tauri::command]
fn git_amend_commit(cwd: String, message: String) -> Result<String, String> {
    let output = std::process::Command::new(git_binary())
        .args(["commit", "--amend", "-m", &message])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git commit --amend: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit --amend failed: {}", stderr));
    }

    let log_output = std::process::Command::new(git_binary())
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
    #[serde(skip_serializing_if = "Option::is_none")]
    conflicts: Option<bool>,
}

#[tauri::command]
fn git_push(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
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
        conflicts: None,
    })
}

#[tauri::command]
fn git_fetch(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
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
        conflicts: None,
    })
}

#[tauri::command]
fn git_merge(cwd: String, branch: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
        .args(["merge", &branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git merge: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let combined = format!("{}{}", stderr, stdout);
    let is_conflict = combined.contains("CONFLICT") || combined.contains("Automatic merge failed");

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            stdout.trim().to_string()
        } else if is_conflict {
            "Merge conflicts detected".to_string()
        } else {
            stderr.trim().to_string()
        },
        conflicts: if is_conflict { Some(true) } else { None },
    })
}

#[tauri::command]
fn git_merge_abort(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
        .args(["merge", "--abort"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git merge --abort: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            "Merge aborted".to_string()
        } else {
            stderr.trim().to_string()
        },
        conflicts: None,
    })
}

#[tauri::command]
fn git_merge_continue(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
        .args(["-c", "core.editor=true", "merge", "--continue"])
        .current_dir(&cwd)
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| format!("Failed to run git merge --continue: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        },
        conflicts: None,
    })
}

#[tauri::command]
fn git_pull(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
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
        conflicts: None,
    })
}

// ─── Git discard changes ─────────────────────────────────────

#[tauri::command]
fn git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    // Restore tracked files
    let mut cmd = std::process::Command::new(git_binary());
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
    let output = std::process::Command::new(git_binary())
        .args(["show", "-m", "--first-parent", "--format=", &hash])
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
    last_commit_date: String,
}

#[tauri::command]
fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    // Use git branch -a --format to get structured output
    let output = std::process::Command::new(git_binary())
        .args([
            "branch", "-a",
            "--format=%(HEAD)%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(objectname:short) %(subject)\x1f%(creatordate:iso)",
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
        let last_commit_date = if parts.len() > 4 { parts[4].trim().to_string() } else { String::new() };

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
            last_commit_date,
        });
    }

    Ok(branches)
}

#[tauri::command]
fn git_create_branch(cwd: String, name: String, checkout: bool) -> Result<(), String> {
    if checkout {
        let output = std::process::Command::new(git_binary())
            .args(["checkout", "-b", &name])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout -b failed: {}", stderr));
        }
    } else {
        let output = std::process::Command::new(git_binary())
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
    let output = std::process::Command::new(git_binary())
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
    let output = std::process::Command::new(git_binary())
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

// ─── Git stash ────────────────────────────────────────────

#[tauri::command]
fn git_stash(cwd: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["stash", "--include-untracked"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git stash: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git stash failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
fn git_stash_pop(cwd: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["stash", "pop"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git stash pop: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git stash pop failed: {}", stderr));
    }
    Ok(())
}

// ─── Conflict Prevention (Phase 8.1) ─────────────────────

#[derive(serde::Serialize)]
struct ConflictRisk {
    /// Branch being compared
    branch: String,
    /// Files modified on both branches since merge-base
    overlapping_files: Vec<String>,
    /// Total files changed on current branch
    current_changed: usize,
    /// Total files changed on target branch
    target_changed: usize,
}

/// Detect files that overlap between the current branch and a target branch.
/// Returns the list of files modified on both sides since their merge-base.
#[tauri::command]
fn git_conflict_check(cwd: String, target_branch: String) -> Result<ConflictRisk, String> {
    let git = git_binary();

    // Find merge-base
    let base_out = std::process::Command::new(&git)
        .args(["merge-base", "HEAD", &target_branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("merge-base failed: {}", e))?;
    if !base_out.status.success() {
        return Err(format!(
            "Cannot find merge-base between HEAD and {}: {}",
            target_branch,
            String::from_utf8_lossy(&base_out.stderr)
        ));
    }
    let base = String::from_utf8_lossy(&base_out.stdout).trim().to_string();

    let ours_files = git_changed_files(&git, &cwd, &base, "HEAD")?;
    let theirs_files = git_changed_files(&git, &cwd, &base, &target_branch)?;

    let ours_set: std::collections::HashSet<&String> = ours_files.iter().collect();
    let overlapping: Vec<String> = theirs_files
        .iter()
        .filter(|f| ours_set.contains(f))
        .cloned()
        .collect();

    Ok(ConflictRisk {
        branch: target_branch,
        overlapping_files: overlapping,
        current_changed: ours_files.len(),
        target_changed: theirs_files.len(),
    })
}

// ─── Cherry-pick (Phase 8.2) ─────────────────────────────

/// Cherry-pick one or more commits onto the current branch.
#[tauri::command]
fn git_cherry_pick(cwd: String, hashes: Vec<String>) -> Result<GitPushPullResult, String> {
    let git = git_binary();
    let mut args = vec!["cherry-pick".to_string()];
    args.extend(hashes);

    let output = std::process::Command::new(&git)
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git cherry-pick: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let has_conflicts = stderr.contains("CONFLICT") || stderr.contains("conflict");

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() { stdout } else { stderr },
        conflicts: Some(has_conflicts),
    })
}

/// Abort an in-progress cherry-pick.
#[tauri::command]
fn git_cherry_pick_abort(cwd: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["cherry-pick", "--abort"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to abort cherry-pick: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "cherry-pick --abort failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Continue a cherry-pick after resolving conflicts.
#[tauri::command]
fn git_cherry_pick_continue(cwd: String) -> Result<GitPushPullResult, String> {
    let output = std::process::Command::new(git_binary())
        .args(["cherry-pick", "--continue"])
        .current_dir(&cwd)
        .env("GIT_EDITOR", "true") // skip editor for commit message
        .output()
        .map_err(|e| format!("Failed to continue cherry-pick: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() { stdout } else { stderr },
        conflicts: None,
    })
}

// ─── Stash Manager (Phase 8.2) ───────────────────────────

#[derive(serde::Serialize)]
struct StashEntry {
    index: usize,
    message: String,
    branch: String,
    date: String,
    hash: String,
}

/// List all stash entries.
#[tauri::command]
fn git_stash_list(cwd: String) -> Result<Vec<StashEntry>, String> {
    let output = std::process::Command::new(git_binary())
        .args(["stash", "list", "--format=%H%x00%gd%x00%gs%x00%ai"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list stashes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for (i, line) in stdout.lines().enumerate() {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() >= 4 {
            // Parse "On <branch>: <message>" from the stash subject
            let subject = parts[2];
            let (branch, message) = if subject.starts_with("On ") {
                if let Some(colon_pos) = subject.find(": ") {
                    (subject[3..colon_pos].to_string(), subject[colon_pos + 2..].to_string())
                } else {
                    (String::new(), subject.to_string())
                }
            } else {
                (String::new(), subject.to_string())
            };

            entries.push(StashEntry {
                index: i,
                message,
                branch,
                date: parts[3].to_string(),
                hash: parts[0].to_string(),
            });
        }
    }

    Ok(entries)
}

/// Apply a stash by index without removing it.
#[tauri::command]
fn git_stash_apply(cwd: String, index: usize) -> Result<(), String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let output = std::process::Command::new(git_binary())
        .args(["stash", "apply", &stash_ref])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to apply stash: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git stash apply failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Drop a stash by index.
#[tauri::command]
fn git_stash_drop(cwd: String, index: usize) -> Result<(), String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let output = std::process::Command::new(git_binary())
        .args(["stash", "drop", &stash_ref])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to drop stash: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git stash drop failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Show the diff of a stash entry.
#[tauri::command]
fn git_stash_show(cwd: String, index: usize) -> Result<String, String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let output = std::process::Command::new(git_binary())
        .args(["stash", "show", "-p", &stash_ref])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to show stash: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git stash show failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Monorepo Awareness (Phase 8.4) ──────────────────────

#[derive(serde::Serialize)]
struct MonorepoPackage {
    name: String,
    path: String,
    version: String,
}

#[derive(serde::Serialize)]
struct MonorepoInfo {
    is_monorepo: bool,
    manager: String, // "pnpm", "npm", "yarn", ""
    packages: Vec<MonorepoPackage>,
}

/// Detect monorepo workspaces (pnpm, npm, yarn).
#[tauri::command]
fn detect_monorepo(cwd: String) -> Result<MonorepoInfo, String> {
    let cwd_path = std::path::Path::new(&cwd);

    // Check pnpm-workspace.yaml
    let pnpm_ws = cwd_path.join("pnpm-workspace.yaml");
    if pnpm_ws.exists() {
        let content = std::fs::read_to_string(&pnpm_ws)
            .map_err(|e| format!("Failed to read pnpm-workspace.yaml: {}", e))?;
        let packages = find_workspace_packages(&cwd, &content, "pnpm");
        return Ok(MonorepoInfo {
            is_monorepo: true,
            manager: "pnpm".to_string(),
            packages,
        });
    }

    // Check package.json workspaces (npm/yarn)
    let pkg_json = cwd_path.join("package.json");
    if pkg_json.exists() {
        let content = std::fs::read_to_string(&pkg_json)
            .map_err(|e| format!("Failed to read package.json: {}", e))?;
        if content.contains("\"workspaces\"") {
            let packages = find_workspace_packages(&cwd, &content, "npm");
            if !packages.is_empty() {
                return Ok(MonorepoInfo {
                    is_monorepo: true,
                    manager: if cwd_path.join("yarn.lock").exists() {
                        "yarn".to_string()
                    } else {
                        "npm".to_string()
                    },
                    packages,
                });
            }
        }
    }

    Ok(MonorepoInfo {
        is_monorepo: false,
        manager: String::new(),
        packages: Vec::new(),
    })
}

/// Scan workspace glob patterns to find packages.
fn find_workspace_packages(cwd: &str, config_content: &str, manager: &str) -> Vec<MonorepoPackage> {
    let mut globs: Vec<String> = Vec::new();

    if manager == "pnpm" {
        // Parse YAML-like: look for lines starting with "  - "
        for line in config_content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("- ") {
                let pattern = trimmed[2..].trim().trim_matches('\'').trim_matches('"');
                globs.push(pattern.to_string());
            }
        }
    } else {
        // Parse JSON workspaces array — simple extraction
        if let Some(start) = config_content.find("\"workspaces\"") {
            let rest = &config_content[start..];
            if let Some(arr_start) = rest.find('[') {
                if let Some(arr_end) = rest[arr_start..].find(']') {
                    let arr = &rest[arr_start + 1..arr_start + arr_end];
                    for item in arr.split(',') {
                        let pattern = item.trim().trim_matches('"').trim_matches('\'');
                        if !pattern.is_empty() {
                            globs.push(pattern.to_string());
                        }
                    }
                }
            }
        }
    }

    let cwd_path = std::path::Path::new(cwd);
    let mut packages = Vec::new();

    for pattern in &globs {
        // Resolve glob pattern to actual directories
        let base_pattern = pattern.replace("/*", "").replace("/**", "");
        let base_dir = cwd_path.join(&base_pattern);
        if base_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&base_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let pkg_json_path = path.join("package.json");
                    if pkg_json_path.exists() {
                        if let Ok(pkg_content) = std::fs::read_to_string(&pkg_json_path) {
                            let name = extract_json_string(&pkg_content, "name")
                                .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
                            let version = extract_json_string(&pkg_content, "version")
                                .unwrap_or_else(|| "0.0.0".to_string());
                            let rel_path = path.strip_prefix(cwd_path)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|_| path.to_string_lossy().to_string());
                            packages.push(MonorepoPackage { name, path: rel_path, version });
                        }
                    }
                }
            }
        }
    }

    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages
}

/// Simple JSON string extractor (no serde_json dependency needed).
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let pos = json.find(&needle)?;
    let rest = &json[pos + needle.len()..];
    let colon = rest.find(':')?;
    let after_colon = rest[colon + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    let value_start = 1;
    let value_end = after_colon[value_start..].find('"')?;
    Some(after_colon[value_start..value_start + value_end].to_string())
}

// ─── PR Workflow (Phase 8.3) ──────────────────────────────

#[derive(serde::Serialize)]
struct RemoteInfo {
    name: String,
    url: String,
    /// "github", "gitlab", "bitbucket", or "unknown"
    provider: String,
    /// Owner/org (e.g. "dendreo")
    owner: String,
    /// Repo name (e.g. "GitWand")
    repo: String,
}

/// Detect the remote provider and extract owner/repo from the URL.
#[tauri::command]
fn git_remote_info(cwd: String) -> Result<RemoteInfo, String> {
    let output = std::process::Command::new(git_binary())
        .args(["remote", "-v"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get remote info: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse the first fetch remote
    for line in stdout.lines() {
        if !line.contains("(fetch)") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let name = parts[0].to_string();
        let url = parts[1].to_string();

        // Determine provider
        let provider = if url.contains("github.com") {
            "github"
        } else if url.contains("gitlab.com") || url.contains("gitlab") {
            "gitlab"
        } else if url.contains("bitbucket.org") || url.contains("bitbucket") {
            "bitbucket"
        } else {
            "unknown"
        };

        // Extract owner/repo from URL
        // Handles: https://github.com/owner/repo.git and git@github.com:owner/repo.git
        let (owner, repo) = parse_remote_owner_repo(&url);

        return Ok(RemoteInfo {
            name,
            url,
            provider: provider.to_string(),
            owner,
            repo,
        });
    }

    Err("No remote found".to_string())
}

fn parse_remote_owner_repo(url: &str) -> (String, String) {
    // SSH format: git@github.com:owner/repo.git
    if let Some(colon_pos) = url.find(':') {
        if url.starts_with("git@") {
            let path = &url[colon_pos + 1..];
            let clean = path.trim_end_matches(".git");
            let parts: Vec<&str> = clean.splitn(2, '/').collect();
            if parts.len() == 2 {
                return (parts[0].to_string(), parts[1].to_string());
            }
        }
    }
    // HTTPS format: https://github.com/owner/repo.git
    if let Some(host_end) = url.find("://") {
        let path = &url[host_end + 3..];
        // Skip the hostname
        if let Some(slash_pos) = path.find('/') {
            let clean = path[slash_pos + 1..].trim_end_matches(".git");
            let parts: Vec<&str> = clean.splitn(2, '/').collect();
            if parts.len() == 2 {
                return (parts[0].to_string(), parts[1].to_string());
            }
        }
    }
    (String::new(), String::new())
}

#[derive(serde::Serialize)]
struct PullRequest {
    number: i64,
    title: String,
    state: String,
    author: String,
    branch: String,
    base: String,
    draft: bool,
    created_at: String,
    updated_at: String,
    url: String,
    additions: i64,
    deletions: i64,
    labels: Vec<String>,
}

/// List open pull requests using `gh` CLI.
#[tauri::command]
fn gh_list_prs(cwd: String, state: String) -> Result<Vec<PullRequest>, String> {
    let st = if state.is_empty() { "open" } else { &state };
    let output = std::process::Command::new("gh")
        .args([
            "pr", "list",
            "--state", st,
            "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,additions,deletions,labels",
            "--limit", "50",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run gh pr list (is GitHub CLI installed?): {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr list failed: {}", stderr));
    }

    // Parse JSON output from gh CLI
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_gh_pr_json(&stdout)
}

fn parse_gh_pr_json(json: &str) -> Result<Vec<PullRequest>, String> {
    // Minimal JSON array parser for gh pr list output
    // Each element has: number, title, state, author{login}, headRefName, baseRefName, isDraft,
    // createdAt, updatedAt, url, additions, deletions, labels[{name}]
    let trimmed = json.trim();
    if trimmed == "[]" || trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let mut prs = Vec::new();

    // Split by objects — find each {...} block
    let mut depth = 0;
    let mut obj_start = None;
    for (i, ch) in trimmed.char_indices() {
        match ch {
            '{' => {
                if depth == 1 {
                    obj_start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 1 {
                    if let Some(start) = obj_start {
                        let obj = &trimmed[start..=i];
                        if let Ok(pr) = parse_single_pr(obj) {
                            prs.push(pr);
                        }
                    }
                    obj_start = None;
                }
            }
            '[' if depth == 0 => { depth = 1; }
            ']' if depth == 1 => { depth = 0; }
            _ => {}
        }
    }

    Ok(prs)
}

fn parse_single_pr(json: &str) -> Result<PullRequest, String> {
    let get_str = |key: &str| -> String {
        extract_json_string(json, key).unwrap_or_default()
    };
    let get_num = |key: &str| -> i64 {
        let needle = format!("\"{}\"", key);
        if let Some(pos) = json.find(&needle) {
            let rest = &json[pos + needle.len()..];
            if let Some(colon) = rest.find(':') {
                let after = rest[colon + 1..].trim_start();
                let end = after.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(after.len());
                return after[..end].parse().unwrap_or(0);
            }
        }
        0
    };
    let get_bool = |key: &str| -> bool {
        let needle = format!("\"{}\"", key);
        if let Some(pos) = json.find(&needle) {
            let rest = &json[pos + needle.len()..];
            if let Some(colon) = rest.find(':') {
                let after = rest[colon + 1..].trim_start();
                return after.starts_with("true");
            }
        }
        false
    };

    // Parse author.login
    let author = if let Some(pos) = json.find("\"author\"") {
        let rest = &json[pos..];
        if let Some(login_pos) = rest.find("\"login\"") {
            let login_rest = &rest[login_pos..];
            extract_json_string(login_rest, "login").unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    // Parse labels array
    let mut labels = Vec::new();
    if let Some(pos) = json.find("\"labels\"") {
        let rest = &json[pos..];
        if let Some(arr_start) = rest.find('[') {
            if let Some(arr_end) = rest[arr_start..].find(']') {
                let arr = &rest[arr_start..arr_start + arr_end + 1];
                // Find all "name" values inside
                let mut search_start = 0;
                while let Some(name_pos) = arr[search_start..].find("\"name\"") {
                    let abs_pos = search_start + name_pos;
                    if let Some(val) = extract_json_string(&arr[abs_pos..], "name") {
                        labels.push(val);
                    }
                    search_start = abs_pos + 6;
                }
            }
        }
    }

    Ok(PullRequest {
        number: get_num("number"),
        title: get_str("title"),
        state: get_str("state"),
        author,
        branch: get_str("headRefName"),
        base: get_str("baseRefName"),
        draft: get_bool("isDraft"),
        created_at: get_str("createdAt"),
        updated_at: get_str("updatedAt"),
        url: get_str("url"),
        additions: get_num("additions"),
        deletions: get_num("deletions"),
        labels,
    })
}

/// Create a pull request using `gh` CLI.
#[tauri::command]
fn gh_create_pr(
    cwd: String,
    title: String,
    body: String,
    base: String,
    draft: bool,
) -> Result<PullRequest, String> {
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--title".to_string(),
        title,
        "--body".to_string(),
        body,
    ];

    if !base.is_empty() {
        args.push("--base".to_string());
        args.push(base);
    }

    if draft {
        args.push("--draft".to_string());
    }

    // Add JSON output
    // Note: gh pr create doesn't support --json, but returns the URL
    let output = std::process::Command::new("gh")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to create PR: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr create failed: {}", stderr));
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Fetch the PR details using the URL
    let view_output = std::process::Command::new("gh")
        .args([
            "pr", "view",
            &url,
            "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,additions,deletions,labels",
        ])
        .current_dir(&cwd)
        .output();

    if let Ok(view) = view_output {
        if view.status.success() {
            let json = String::from_utf8_lossy(&view.stdout);
            if let Ok(pr) = parse_single_pr(&json) {
                return Ok(pr);
            }
        }
    }

    // Fallback: return minimal info
    Ok(PullRequest {
        number: 0,
        title: String::new(),
        state: "open".to_string(),
        author: String::new(),
        branch: String::new(),
        base: String::new(),
        draft: false,
        created_at: String::new(),
        updated_at: String::new(),
        url,
        additions: 0,
        deletions: 0,
        labels: Vec::new(),
    })
}

/// Checkout a PR branch locally using `gh` CLI.
#[tauri::command]
fn gh_checkout_pr(cwd: String, number: i64) -> Result<(), String> {
    let output = std::process::Command::new("gh")
        .args(["pr", "checkout", &number.to_string()])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to checkout PR: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Merge a PR using `gh` CLI.
#[tauri::command]
fn gh_merge_pr(cwd: String, number: i64, method: String) -> Result<(), String> {
    let merge_flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };

    let output = std::process::Command::new("gh")
        .args(["pr", "merge", &number.to_string(), merge_flag, "--delete-branch"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to merge PR: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr merge failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

// ─── PR Detail & Diff (Phase 9.1) ─────────────────────────

#[derive(serde::Serialize)]
struct PullRequestDetail {
    number: i64,
    title: String,
    body: String,
    state: String,
    author: String,
    branch: String,
    base: String,
    draft: bool,
    created_at: String,
    updated_at: String,
    merged_at: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i64,
    comments: i64,
    review_comments: i64,
    labels: Vec<String>,
    reviewers: Vec<String>,
    mergeable: String,
    checks_status: String,
}

/// Get detailed PR information using `gh` CLI.
#[tauri::command]
fn gh_pr_detail(cwd: String, number: i64) -> Result<PullRequestDetail, String> {
    let output = std::process::Command::new("gh")
        .args([
            "pr", "view", &number.to_string(),
            "--json", "number,title,body,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,mergedAt,url,additions,deletions,changedFiles,comments,reviewRequests,labels,reviews,mergeable,statusCheckRollup",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr view: {}", e))?;

    if !output.status.success() {
        return Err(format!("gh pr view failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let json = String::from_utf8_lossy(&output.stdout);
    let json = json.trim();

    let get_str = |key: &str| -> String {
        extract_json_string(json, key).unwrap_or_default()
    };
    let get_num = |key: &str| -> i64 {
        let needle = format!("\"{}\"", key);
        if let Some(pos) = json.find(&needle) {
            let rest = &json[pos + needle.len()..];
            if let Some(colon) = rest.find(':') {
                let after = rest[colon + 1..].trim_start();
                let end = after.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(after.len());
                return after[..end].parse().unwrap_or(0);
            }
        }
        0
    };
    let get_bool = |key: &str| -> bool {
        let needle = format!("\"{}\"", key);
        if let Some(pos) = json.find(&needle) {
            let rest = &json[pos + needle.len()..];
            if let Some(colon) = rest.find(':') {
                let after = rest[colon + 1..].trim_start();
                return after.starts_with("true");
            }
        }
        false
    };

    // Parse author.login
    let author = if let Some(pos) = json.find("\"author\"") {
        let rest = &json[pos..];
        extract_json_string(rest, "login").unwrap_or_default()
    } else { String::new() };

    // Parse labels array
    let mut labels = Vec::new();
    if let Some(pos) = json.find("\"labels\"") {
        let rest = &json[pos..];
        if let Some(arr_start) = rest.find('[') {
            if let Some(arr_end) = rest[arr_start..].find(']') {
                let arr = &rest[arr_start..arr_start + arr_end + 1];
                let mut search_start = 0;
                while let Some(name_pos) = arr[search_start..].find("\"name\"") {
                    let abs_pos = search_start + name_pos;
                    if let Some(val) = extract_json_string(&arr[abs_pos..], "name") {
                        labels.push(val);
                    }
                    search_start = abs_pos + 6;
                }
            }
        }
    }

    // Parse reviewers from reviewRequests
    let mut reviewers = Vec::new();
    if let Some(pos) = json.find("\"reviewRequests\"") {
        let rest = &json[pos..];
        if let Some(arr_start) = rest.find('[') {
            if let Some(arr_end) = rest[arr_start..].find(']') {
                let arr = &rest[arr_start..arr_start + arr_end + 1];
                let mut search_start = 0;
                while let Some(login_pos) = arr[search_start..].find("\"login\"") {
                    let abs_pos = search_start + login_pos;
                    if let Some(val) = extract_json_string(&arr[abs_pos..], "login") {
                        reviewers.push(val);
                    }
                    search_start = abs_pos + 7;
                }
            }
        }
    }

    // Parse comments count
    let comments = if let Some(pos) = json.find("\"comments\"") {
        let rest = &json[pos..];
        if let Some(arr_start) = rest.find('[') {
            if let Some(arr_end) = rest[arr_start..].find(']') {
                let arr = &rest[arr_start..arr_start + arr_end + 1];
                arr.matches('{').count() as i64
            } else { 0 }
        } else { 0 }
    } else { 0 };

    // Parse review comments count from reviews
    let review_comments = if let Some(pos) = json.find("\"reviews\"") {
        let rest = &json[pos..];
        if let Some(arr_start) = rest.find('[') {
            if let Some(arr_end) = rest[arr_start..].find(']') {
                let arr = &rest[arr_start..arr_start + arr_end + 1];
                arr.matches('{').count() as i64
            } else { 0 }
        } else { 0 }
    } else { 0 };

    // Parse checks status from statusCheckRollup
    let checks_status = if let Some(pos) = json.find("\"statusCheckRollup\"") {
        let rest = &json[pos..];
        if rest.contains("\"FAILURE\"") || rest.contains("\"ERROR\"") {
            "failure".to_string()
        } else if rest.contains("\"PENDING\"") || rest.contains("\"QUEUED\"") || rest.contains("\"IN_PROGRESS\"") {
            "pending".to_string()
        } else if rest.contains("\"SUCCESS\"") {
            "success".to_string()
        } else {
            "unknown".to_string()
        }
    } else {
        "unknown".to_string()
    };

    Ok(PullRequestDetail {
        number: get_num("number"),
        title: get_str("title"),
        body: get_str("body"),
        state: get_str("state"),
        author,
        branch: get_str("headRefName"),
        base: get_str("baseRefName"),
        draft: get_bool("isDraft"),
        created_at: get_str("createdAt"),
        updated_at: get_str("updatedAt"),
        merged_at: get_str("mergedAt"),
        url: get_str("url"),
        additions: get_num("additions"),
        deletions: get_num("deletions"),
        changed_files: get_num("changedFiles"),
        comments,
        review_comments,
        labels,
        reviewers,
        mergeable: get_str("mergeable"),
        checks_status,
    })
}

/// Get the diff of a PR using `gh` CLI.
#[tauri::command]
fn gh_pr_diff(cwd: String, number: i64) -> Result<String, String> {
    let output = std::process::Command::new("gh")
        .args(["pr", "diff", &number.to_string()])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr diff: {}", e))?;

    if !output.status.success() {
        return Err(format!("gh pr diff failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get CI checks for a PR using `gh` CLI.
#[tauri::command]
fn gh_pr_checks(cwd: String, number: i64) -> Result<Vec<CICheck>, String> {
    let output = std::process::Command::new("gh")
        .args([
            "pr", "checks", &number.to_string(),
            "--json", "name,state,conclusion,detailsUrl",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr checks: {}", e))?;

    if !output.status.success() {
        // Some repos have no checks — not a fatal error
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed == "[]" || trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let mut checks = Vec::new();
    let mut depth = 0;
    let mut obj_start = None;
    for (i, ch) in trimmed.char_indices() {
        match ch {
            '{' => {
                if depth == 1 { obj_start = Some(i); }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 1 {
                    if let Some(start) = obj_start {
                        let obj = &trimmed[start..=i];
                        checks.push(CICheck {
                            name: extract_json_string(obj, "name").unwrap_or_default(),
                            state: extract_json_string(obj, "state").unwrap_or_default(),
                            conclusion: extract_json_string(obj, "conclusion").unwrap_or_default(),
                            details_url: extract_json_string(obj, "detailsUrl").unwrap_or_default(),
                        });
                    }
                    obj_start = None;
                }
            }
            '[' if depth == 0 => { depth = 1; }
            ']' if depth == 1 => { depth = 0; }
            _ => {}
        }
    }

    Ok(checks)
}

#[derive(serde::Serialize)]
struct CICheck {
    name: String,
    state: String,
    conclusion: String,
    details_url: String,
}

// ─── Terminal Command Execution (Phase 8.5) ───────────────

#[derive(serde::Serialize)]
struct TerminalResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

/// Execute a git command in the repo directory. Only allows git commands for safety.
#[tauri::command]
fn git_exec(cwd: String, args: Vec<String>) -> Result<TerminalResult, String> {
    // Safety: only allow git subcommands
    if args.is_empty() {
        return Err("No arguments provided".to_string());
    }

    let output = std::process::Command::new(git_binary())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

    Ok(TerminalResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// List git subcommands and branch names for terminal autocomplete.
#[tauri::command]
fn git_autocomplete(cwd: String, partial: String) -> Result<Vec<String>, String> {
    let mut suggestions = Vec::new();

    // If the partial looks like it's completing a subcommand (no spaces yet)
    if !partial.contains(' ') {
        let subcommands = [
            "add", "bisect", "blame", "branch", "checkout", "cherry-pick",
            "clone", "commit", "config", "diff", "fetch", "grep", "init",
            "log", "merge", "mv", "pull", "push", "rebase", "remote",
            "reset", "restore", "revert", "rm", "show", "stash", "status",
            "switch", "tag",
        ];
        for cmd in &subcommands {
            if cmd.starts_with(&partial) {
                suggestions.push(cmd.to_string());
            }
        }
    } else {
        // Completing an argument — suggest branch names and tags
        let parts: Vec<&str> = partial.splitn(2, ' ').collect();
        let arg_prefix = if parts.len() > 1 {
            parts[1].split_whitespace().last().unwrap_or("")
        } else {
            ""
        };

        // Get branch names
        let output = std::process::Command::new(git_binary())
            .args(["for-each-ref", "--format=%(refname:short)", "refs/heads/", "refs/tags/"])
            .current_dir(&cwd)
            .output();

        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for name in stdout.lines() {
                if name.starts_with(arg_prefix) {
                    suggestions.push(name.to_string());
                }
            }
        }
    }

    Ok(suggestions)
}

// ─── Read .gitwandrc ──────────────────────────────────────

/// Lit la configuration .gitwandrc du repo (Phase 7.4).
/// Cherche dans cet ordre :
///   1. {cwd}/.gitwandrc
///   2. {cwd}/.gitwandrc.json
///   3. Clé "gitwand" dans {cwd}/package.json
/// Retourne la chaîne JSON brute ou "" si non trouvé.
#[tauri::command]
fn read_gitwandrc(cwd: String) -> String {
    let cwd_path = std::path::Path::new(&cwd);

    // 1. .gitwandrc
    let rc_path = cwd_path.join(".gitwandrc");
    if rc_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&rc_path) {
            return content;
        }
    }

    // 2. .gitwandrc.json
    let rc_json_path = cwd_path.join(".gitwandrc.json");
    if rc_json_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&rc_json_path) {
            return content;
        }
    }

    // 3. "gitwand" dans package.json
    let pkg_path = cwd_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg_path) {
            // Parser manuellement pour éviter une dépendance serde_json supplémentaire
            // On cherche "gitwand": { ... } et on retourne l'objet brut
            if let Some(start) = find_json_key_value_start(&content, "gitwand") {
                return start;
            }
        }
    }

    String::new()
}

/// Extrait la valeur d'une clé JSON de premier niveau depuis une chaîne JSON.
/// Retourne la valeur brute (string JSON) ou None si non trouvée.
fn find_json_key_value_start(json: &str, key: &str) -> Option<String> {
    let search = format!("\"{}\"", key);
    let key_pos = json.find(&search)?;
    let after_key = &json[key_pos + search.len()..];
    let colon_pos = after_key.find(':')?;
    let value_start = after_key[colon_pos + 1..].trim_start();

    // Extraire l'objet ou tableau complet (gestion basique des accolades)
    if !value_start.starts_with('{') {
        return None; // On n'attend qu'un objet
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape_next = false;
    let mut end = 0usize;

    for (i, c) in value_start.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        match c {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    end = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if end > 0 {
        Some(value_start[..end].to_string())
    } else {
        None
    }
}

// ─── Merge Preview (Phase 8.1) ───────────────────────────
//
// Calcule un aperçu "sans effet de bord" de ce qui se passerait
// si on mergait `source_branch` dans HEAD.
//
// Algorithme :
//   1. git merge-base HEAD <branch>  → ancêtre commun
//   2. git diff --name-only <base> HEAD   → fichiers modifiés côté ours
//   3. git diff --name-only <base> <branch> → fichiers modifiés côté theirs
//   4. intersection → fichiers potentiellement en conflit
//   5. Pour chaque fichier : git show <ref>:<file> pour les 3 versions
//   6. git merge-file -p (dans un répertoire temp) → contenu avec marqueurs
//   7. Retourner la liste brute — le résolveur tourne côté frontend (TypeScript)

#[derive(serde::Serialize, Clone)]
pub struct FileMergePreview {
    /// Chemin relatif du fichier dans le repo
    file_path: String,
    /// Contenu avec marqueurs de conflit (sortie de git merge-file -p)
    /// Vide si les deux versions sont identiques après merge
    conflict_content: String,
    /// True si le contenu contient des marqueurs de conflit Git
    has_conflicts: bool,
    /// True si le fichier n'existe que d'un côté (ajout/suppression unilatérale)
    is_add_delete: bool,
}

#[tauri::command]
fn preview_merge(cwd: String, source_branch: String) -> Result<Vec<FileMergePreview>, String> {
    let git = git_binary();

    // 1. Merge-base
    let base_out = std::process::Command::new(&git)
        .args(["merge-base", "HEAD", &source_branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("merge-base failed: {}", e))?;
    if !base_out.status.success() {
        return Err(format!(
            "Cannot find merge-base: {}",
            String::from_utf8_lossy(&base_out.stderr)
        ));
    }
    let base = String::from_utf8_lossy(&base_out.stdout).trim().to_string();

    // 2. Fichiers modifiés dans HEAD depuis base
    let ours_files = git_changed_files(&git, &cwd, &base, "HEAD")?;
    // 3. Fichiers modifiés dans source_branch depuis base
    let theirs_files = git_changed_files(&git, &cwd, &base, &source_branch)?;

    // 4. Intersection : modifiés des deux côtés
    let ours_set: std::collections::HashSet<&String> = ours_files.iter().collect();
    let both_modified: Vec<&String> = theirs_files.iter().filter(|f| ours_set.contains(f)).collect();

    // 5. Fichiers supprimés/ajoutés unilatéralement
    let theirs_set: std::collections::HashSet<&String> = theirs_files.iter().collect();
    let only_ours: Vec<&String> = ours_files.iter().filter(|f| !theirs_set.contains(f)).collect();
    let only_theirs: Vec<&String> = theirs_files.iter().filter(|f| !ours_set.contains(f)).collect();

    let tmp = std::env::temp_dir();
    let mut results: Vec<FileMergePreview> = Vec::new();

    // 6. Pour chaque fichier modifié des deux côtés → tenter git merge-file
    for file_path in both_modified {
        let preview = merge_file_preview(&git, &cwd, &base, "HEAD", &source_branch, file_path, &tmp);
        results.push(preview);
    }

    // Fichiers seulement modifiés côté ours → pas de conflit
    for file_path in only_ours {
        results.push(FileMergePreview {
            file_path: file_path.clone(),
            conflict_content: String::new(),
            has_conflicts: false,
            is_add_delete: false,
        });
    }

    // Fichiers seulement modifiés côté theirs → pas de conflit (theirs gagne)
    for file_path in only_theirs {
        results.push(FileMergePreview {
            file_path: file_path.clone(),
            conflict_content: String::new(),
            has_conflicts: false,
            is_add_delete: false,
        });
    }

    // Trier : conflits en premier, puis par chemin
    results.sort_by(|a, b| {
        b.has_conflicts.cmp(&a.has_conflicts)
            .then(a.file_path.cmp(&b.file_path))
    });

    Ok(results)
}

/// Retourne la liste des fichiers modifiés entre `base` et `rev` (noms relatifs uniquement).
fn git_changed_files(git: &str, cwd: &str, base: &str, rev: &str) -> Result<Vec<String>, String> {
    let out = std::process::Command::new(git)
        .args(["diff", "--name-only", base, rev])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("diff --name-only failed: {}", e))?;

    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// Tente de merger les trois versions d'un fichier avec git merge-file.
/// Retourne le contenu résultant (avec ou sans marqueurs de conflit).
fn merge_file_preview(
    git: &str,
    cwd: &str,
    base_ref: &str,
    ours_ref: &str,
    theirs_ref: &str,
    file_path: &str,
    tmp: &std::path::Path,
) -> FileMergePreview {
    /// Lire le contenu d'un fichier à une révision donnée. Retourne None si absent.
    fn git_show_file(git: &str, cwd: &str, rev: &str, path: &str) -> Option<Vec<u8>> {
        let spec = format!("{}:{}", rev, path);
        let out = std::process::Command::new(git)
            .args(["show", &spec])
            .current_dir(cwd)
            .output()
            .ok()?;
        if out.status.success() { Some(out.stdout) } else { None }
    }

    let base_bytes = git_show_file(git, cwd, base_ref, file_path);
    let ours_bytes = git_show_file(git, cwd, ours_ref, file_path);
    let theirs_bytes = git_show_file(git, cwd, theirs_ref, file_path);

    // Si un côté n'a pas le fichier → add/delete conflict
    match (&ours_bytes, &theirs_bytes) {
        (None, _) | (_, None) => {
            return FileMergePreview {
                file_path: file_path.to_string(),
                conflict_content: String::new(),
                has_conflicts: true,
                is_add_delete: true,
            };
        }
        _ => {}
    }

    // Écrire les trois versions dans des fichiers temporaires
    let prefix = file_path.replace(['/', '\\', '.'], "_");
    let tmp_base  = tmp.join(format!("{}_base.tmp", prefix));
    let tmp_ours  = tmp.join(format!("{}_ours.tmp", prefix));
    let tmp_theirs = tmp.join(format!("{}_theirs.tmp", prefix));

    let write_or_empty = |path: &std::path::Path, bytes: &Option<Vec<u8>>| {
        let content = bytes.as_deref().unwrap_or(b"");
        std::fs::write(path, content)
    };

    if write_or_empty(&tmp_base, &base_bytes).is_err()
        || write_or_empty(&tmp_ours, &ours_bytes).is_err()
        || write_or_empty(&tmp_theirs, &theirs_bytes).is_err()
    {
        return FileMergePreview {
            file_path: file_path.to_string(),
            conflict_content: String::new(),
            has_conflicts: true,
            is_add_delete: false,
        };
    }

    // git merge-file -p <ours> <base> <theirs>  (note: ordre ours/base/theirs)
    let merge_out = std::process::Command::new("git")
        .args([
            "merge-file",
            "-p",
            "--diff3",
            tmp_ours.to_str().unwrap_or(""),
            tmp_base.to_str().unwrap_or(""),
            tmp_theirs.to_str().unwrap_or(""),
        ])
        .output();

    // Nettoyer
    let _ = std::fs::remove_file(&tmp_base);
    let _ = std::fs::remove_file(&tmp_ours);
    let _ = std::fs::remove_file(&tmp_theirs);

    match merge_out {
        Ok(out) => {
            let content = String::from_utf8_lossy(&out.stdout).to_string();
            // git merge-file retourne exit code 1 si conflit, 0 si merge propre
            let has_conflicts = !out.status.success() || content.contains("<<<<<<<");
            FileMergePreview {
                file_path: file_path.to_string(),
                conflict_content: content,
                has_conflicts,
                is_add_delete: false,
            }
        }
        Err(_) => FileMergePreview {
            file_path: file_path.to_string(),
            conflict_content: String::new(),
            has_conflicts: true,
            is_add_delete: false,
        },
    }
}

// ─── Open in external editor ──────────────────────────────

#[tauri::command]
fn open_in_editor(cwd: String, path: String, editor: String) -> Result<(), String> {
    let editor_cmd = if editor.trim().is_empty() {
        "code".to_string()
    } else {
        editor.trim().to_string()
    };
    let full_path = std::path::Path::new(&cwd).join(&path);
    std::process::Command::new(&editor_cmd)
        .arg(&full_path)
        .spawn()
        .map_err(|e| format!("Failed to open editor '{}': {}", editor_cmd, e))?;
    Ok(())
}

// ─── Tauri entry point ─────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Register Cmd+Shift+G (macOS) / Ctrl+Shift+G (Linux/Windows)
            // to bring GitWand to the foreground from anywhere.
            use tauri_plugin_global_shortcut::ShortcutState;
            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+G", move |_app, shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    // Show + focus the main window
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    // Emit event so frontend can react (e.g. open folder picker)
                    let _ = handle.emit("global-shortcut-activate", ());
                }
            })?;
            Ok(())
        })
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
            git_stage_patch,
            git_unstage_patch,
            git_commit,
            git_amend_commit,
            git_push,
            git_pull,
            git_fetch,
            git_merge,
            git_merge_abort,
            git_merge_continue,
            git_discard,
            git_show,
            git_branches,
            git_create_branch,
            git_switch_branch,
            git_delete_branch,
            git_stash,
            git_stash_pop,
            open_in_editor,
            set_git_config,
            read_gitwandrc,
            preview_merge,
            git_conflict_check,
            git_cherry_pick,
            git_cherry_pick_abort,
            git_cherry_pick_continue,
            git_stash_list,
            git_stash_apply,
            git_stash_drop,
            git_stash_show,
            detect_monorepo,
            git_remote_info,
            gh_list_prs,
            gh_create_pr,
            gh_checkout_pr,
            gh_merge_pr,
            gh_pr_detail,
            gh_pr_diff,
            gh_pr_checks,
            git_exec,
            git_autocomplete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitWand");
}

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
///
/// ─── Trust boundaries ──────────────────────────────────────
///
/// Tauri commands live on a trust boundary: inputs come from the webview,
/// where they may originate from untrusted repo content (READMEs, PR bodies,
/// file names). Categories of commands and their security invariants:
///
/// 1. **Filesystem read/write** (`read_file`, `write_file`, `list_dir`):
///    - Paths are constrained under an explicit `cwd` root via `safe_repo_path`.
///    - No `..` segments may escape the root.
///
/// 2. **Git command execution** (`get_conflicted_files`, diff/log/status, etc.):
///    - Arguments are passed mechanically via `.arg()` — never interpolated
///      into a shell string. Safe by construction against command injection.
///    - `cwd` is used as `.current_dir()` for the process, so the git binary
///      itself confines filesystem access to the repo.
///
/// 3. **External CLI execution** (`gh`, `claude`, editor): same rules as (2).
///    `claude` runs with API-key env vars stripped to force the OAuth session.
///
/// 4. **Window / IPC events**: trusted frontend-only surface.
///
/// When adding a new command, classify it against one of these categories and
/// reuse the helpers below.

/// Ensure `rel_path`, resolved under `cwd`, stays inside the canonical `cwd`.
///
/// Rejects empty paths, absolute `rel_path` that would escape the root,
/// and any resolution that lands outside `cwd` (defense against `..` traversal
/// and symlink escapes).
fn safe_repo_path(cwd: &str, rel_path: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    if rel_path.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }

    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be absolute (got: {})", cwd));
    }

    let cwd_canonical = cwd_path
        .canonicalize()
        .map_err(|e| format!("cwd does not resolve: {}", e))?;

    // Treat rel_path as relative to cwd. If it happens to be absolute we still
    // require it to sit below cwd_canonical after resolution.
    let joined = cwd_canonical.join(rel_path);

    // For writes the target file may not exist yet — canonicalize the parent
    // directory instead and reassemble the final path.
    let resolved = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = joined.parent().ok_or("path has no parent")?;
            let parent_canonical = parent
                .canonicalize()
                .map_err(|e| format!("parent path does not resolve: {}", e))?;
            let file_name = joined.file_name().ok_or("path has no file name")?;
            parent_canonical.join(file_name)
        }
    };

    if !resolved.starts_with(&cwd_canonical) {
        return Err(format!(
            "path escapes cwd (resolved: {}, cwd: {})",
            resolved.display(),
            cwd_canonical.display()
        ));
    }

    Ok(resolved)
}

// ─── Configurable git binary ──────────────────────────────
//
// Defaults to "git" (resolved from PATH).
// Updated at runtime via the `set_git_config` Tauri command when the user
// sets a custom git path in Settings.

static GIT_BINARY: OnceLock<Mutex<String>> = OnceLock::new();

pub fn git_binary() -> String {
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
pub struct FileChange {
    path: String,
    status: String, // "added", "modified", "deleted", "renamed"
    old_path: Option<String>,
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    remote: Option<String>,     // upstream tracking branch (fetch remote)
    ahead: i32,                 // commits ahead of upstream
    behind: i32,                // commits behind upstream
    /// Push remote when it differs from the upstream (fork / triangular workflow).
    /// None when push_remote == upstream or there is no push remote.
    push_remote: Option<String>,
    ahead_push: i32,            // commits ahead of push remote
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

    // ── Triangular / fork workflow ───────────────────────────────────────────
    // When push.default = "upstream" or a fork is set up, the push remote may
    // differ from the upstream (fetch) remote. Detect this and compute a
    // separate ahead count so the UI can show two distinct badges.
    let mut push_remote: Option<String> = None;
    let mut ahead_push: i32 = 0;

    let push_ref_out = std::process::Command::new(git_binary())
        .args(["rev-parse", "--abbrev-ref", "@{push}"])
        .current_dir(&cwd)
        .output();

    if let Ok(p) = push_ref_out {
        if p.status.success() {
            let push_ref = String::from_utf8_lossy(&p.stdout).trim().to_string();
            let upstream_ref = remote.as_deref().unwrap_or("");
            // Only proceed if push remote is set AND differs from upstream
            if !push_ref.is_empty() && push_ref != upstream_ref {
                // ahead of push remote (how many commits would be pushed)
                let rl = std::process::Command::new(git_binary())
                    .args(["rev-list", "--count", &format!("{}..HEAD", push_ref)])
                    .current_dir(&cwd)
                    .output();
                if let Ok(o) = rl {
                    if o.status.success() {
                        ahead_push = String::from_utf8_lossy(&o.stdout)
                            .trim().parse().unwrap_or(0);
                    }
                }
                push_remote = Some(push_ref);
            }
        }
    }

    Ok(GitStatus {
        branch,
        remote,
        ahead,
        behind,
        push_remote,
        ahead_push,
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
    /// File-level status as reported by the diff extended header
    /// ("new file mode", "deleted file mode", "rename from/to"). Defaults to
    /// "modified" for a plain diff with no such extended line.
    /// The frontend needs this to build a valid `git apply` patch when
    /// splitting a commit: new files must use `--- /dev/null` rather than
    /// `--- a/<path>` or the apply fails with "does not exist in index".
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "oldPath")]
    old_path: Option<String>,
}

/// Parse the stdout of a `git diff` (or `git diff --no-index`) command into
/// a list of `DiffHunk`s. The `status` return value is `Some("added")` when
/// a `new file mode` header is detected in the diff preamble.
fn parse_diff_hunks(stdout: &str) -> (Vec<DiffHunk>, Option<String>) {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line_no = 0u32;
    let mut new_line_no = 0u32;
    let mut detected_status: Option<String> = None;

    for line in stdout.lines() {
        // Detect "new file mode …" in the diff preamble (before any @@).
        if line.starts_with("new file mode") {
            detected_status = Some("added".to_string());
            continue;
        }

        if line.starts_with("@@") {
            // Save previous hunk if exists
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
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
            } else if line.starts_with(' ') {
                // Real context line: space + content (possibly empty). An
                // empty source line renders as " " (length 1), not "" — blank
                // separator lines produced by `lines()` between diff sections
                // are NOT context. Treating them as context adds a phantom
                // line that corrupts hunk counts and breaks patches built
                // from this diff (e.g. `git apply` rejecting a new-file split
                // with "new file X depends on old contents").
                let content = line[1..].to_string();
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

    (hunks, detected_status)
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
    let (mut hunks, mut status) = parse_diff_hunks(&stdout);

    // Untracked (not-yet-staged) files produce no output from `git diff`.
    // Fall back to `git diff --no-index -- /dev/null <path>` which generates
    // a proper "new file" diff with every line shown as an addition.
    // Note: --no-index always exits with code 1 when files differ, so we
    // ignore the exit status and only look at stdout.
    if !staged && hunks.is_empty() {
        if let Ok(fb) = std::process::Command::new(git_binary())
            .args(["diff", "--no-index", "--", "/dev/null", &path])
            .current_dir(&cwd)
            .output()
        {
            let fb_stdout = String::from_utf8_lossy(&fb.stdout);
            let (fb_hunks, fb_status) = parse_diff_hunks(&fb_stdout);
            if !fb_hunks.is_empty() {
                hunks = fb_hunks;
                status = fb_status.or(Some("added".to_string()));
            }
        }
    }

    Ok(GitDiff {
        path,
        hunks,
        status,
        old_path: None,
    })
}

// ─── Git log ───────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitLogEntry {
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
fn git_get_user(cwd: String) -> Result<serde_json::Value, String> {
    let name_out = std::process::Command::new(git_binary())
        .args(["config", "user.name"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git config: {}", e))?;
    let email_out = std::process::Command::new(git_binary())
        .args(["config", "user.email"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git config: {}", e))?;
    let name = String::from_utf8_lossy(&name_out.stdout).trim().to_string();
    let email = String::from_utf8_lossy(&email_out.stdout).trim().to_string();
    Ok(serde_json::json!({ "name": name, "email": email }))
}

#[tauri::command]
fn git_log(
    cwd: String,
    count: Option<i32>,
    all: Option<bool>,
    author: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    let limit = count.unwrap_or(50);
    // Default: current branch only (like `git log`). Pass `all: true` to include all refs.
    let include_all = all.unwrap_or(false);

    // Use unit separator (ASCII 0x1f) to delimit fields
    let format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";

    let mut args: Vec<String> = vec!["log".to_string()];
    if include_all {
        args.push("--all".to_string());
    }
    if let Some(ref author_filter) = author {
        if !author_filter.is_empty() {
            args.push(format!("--author={}", author_filter));
        }
    }
    args.push(format!("-n{}", limit));
    args.push(format!("--format={}", format));

    let output = std::process::Command::new(git_binary())
        .args(&args)
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
fn read_file(cwd: String, path: String) -> Result<String, String> {
    let full = safe_repo_path(&cwd, &path)?;
    std::fs::read_to_string(&full).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(cwd: String, path: String, content: String) -> Result<(), String> {
    let full = safe_repo_path(&cwd, &path)?;
    std::fs::write(&full, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Return the raw bytes of a file at a specific git revision (or the working tree).
///
/// Used by the image-diff pipeline (v1.6.2) to fetch the "old" and "new" versions
/// of a binary file without needing a temporary checkout. Supports any file type;
/// the caller is responsible for handling the bytes (decode image, compute hash…).
///
/// Arguments:
/// - `rev`  — a git rev (`HEAD`, `HEAD^`, a hash, a branch name, `":0"` for the
///            index). If empty, the file is read from disk (working tree).
/// - `path` — path relative to `cwd`.
///
/// Returns a struct with base64-encoded bytes, byte length, and MIME guess.
#[derive(Serialize)]
struct FileAtRevision {
    bytes_base64: String,
    byte_length: usize,
    mime: String,
    /// True when the file is absent at the requested revision (returns empty bytes).
    absent: bool,
}

fn guess_mime_from_ext(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn read_file_at_revision(
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
        let output = std::process::Command::new(git_binary())
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

// ─── Folder diff (v1.6.3) ──────────────────────────────────
//
// Builds an aggregated folder tree from a git diff between two revisions.
// Stats (additions/deletions/files_changed) are propagated up from files to
// their ancestor folders. Renames are detected via `--find-renames` and
// collapsed onto the new path (old path surfaced as `old_path` on the node).
//
// The shape is a single root node whose `children` hold the top-level
// folders/files of the diff — the frontend renders that root's children
// directly.

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct FolderDiffNode {
    /// Full repo-relative path for this node ("" for the synthetic root).
    path: String,
    /// Last path segment ("" for the root).
    name: String,
    /// "folder" or "file".
    kind: String,
    /// For files: single-letter status from `git diff --name-status`
    /// (A/M/D/R/C/T). None for folders or the root.
    status: Option<String>,
    /// For renames/copies: original path before the rename.
    old_path: Option<String>,
    /// Aggregate count of files with changes (1 for a file node,
    /// sum of descendant files for a folder).
    files_changed: u32,
    /// Aggregate added lines (0 for binary files).
    additions: u32,
    /// Aggregate deleted lines (0 for binary files).
    deletions: u32,
    /// True for binary files (numstat reports `-\t-` for binary diffs).
    binary: bool,
    /// Child entries, sorted folders-first then alphabetical by name.
    children: Vec<FolderDiffNode>,
}

struct RawFileChange {
    new_path: String,
    old_path: Option<String>,
    status: String,
    additions: u32,
    deletions: u32,
    binary: bool,
}

/// Parse `git diff -z --name-status --find-renames` output.
///
/// Format (null-separated tokens):
///   M\0path\0         — added/modified/deleted/type-changed
///   A\0path\0
///   D\0path\0
///   T\0path\0
///   R100\0old\0new\0  — rename or copy, with a similarity score
///   C80\0old\0new\0
fn parse_name_status_z(s: &str) -> Vec<(String, String, Option<String>)> {
    let tokens: Vec<&str> = s.split('\0').filter(|t| !t.is_empty()).collect();
    let mut result: Vec<(String, String, Option<String>)> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let status_full = tokens[i];
        let letter = status_full.chars().next().unwrap_or('M').to_ascii_uppercase();
        if letter == 'R' || letter == 'C' {
            if i + 2 < tokens.len() {
                let old = tokens[i + 1].to_string();
                let new_path = tokens[i + 2].to_string();
                result.push((new_path, letter.to_string(), Some(old)));
                i += 3;
            } else {
                break;
            }
        } else {
            if i + 1 < tokens.len() {
                let new_path = tokens[i + 1].to_string();
                result.push((new_path, letter.to_string(), None));
                i += 2;
            } else {
                break;
            }
        }
    }
    result
}

/// Parse `git diff -z --numstat --find-renames` output.
///
/// Format:
///   N\tM\tpath\0                 — non-rename (binary uses "-\t-")
///   N\tM\t\0old_path\0new_path\0 — rename/copy header (empty path after
///                                  the second tab)
///
/// Returns a map keyed by the new path.
fn parse_numstat_z(s: &str) -> HashMap<String, (u32, u32, bool)> {
    // Keep empties in place so we can detect the rename sentinel; split_terminator
    // would swallow the trailing empty after the last \0.
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut result: HashMap<String, (u32, u32, bool)> = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let head = tokens[i];
        if head.is_empty() {
            i += 1;
            continue;
        }
        let parts: Vec<&str> = head.splitn(3, '\t').collect();
        if parts.len() < 2 {
            i += 1;
            continue;
        }
        let adds_str = parts[0];
        let dels_str = parts[1];
        let binary = adds_str == "-" && dels_str == "-";
        let additions: u32 = if binary { 0 } else { adds_str.parse().unwrap_or(0) };
        let deletions: u32 = if binary { 0 } else { dels_str.parse().unwrap_or(0) };
        let path_part = if parts.len() >= 3 { parts[2] } else { "" };
        if path_part.is_empty() {
            // Rename header: consume the next two non-empty tokens as old/new.
            let mut j = i + 1;
            let mut collected: Vec<&str> = Vec::new();
            while j < tokens.len() && collected.len() < 2 {
                if !tokens[j].is_empty() {
                    collected.push(tokens[j]);
                }
                j += 1;
            }
            if collected.len() == 2 {
                result.insert(collected[1].to_string(), (additions, deletions, binary));
                i = j;
            } else {
                break;
            }
        } else {
            result.insert(path_part.to_string(), (additions, deletions, binary));
            i += 1;
        }
    }
    result
}

/// Build the git argv for a ref comparison.
///
/// Semantics:
/// - both empty            → `diff HEAD`              (working tree vs HEAD)
/// - ref_a set, ref_b empty → `diff <ref_a>`           (working tree vs ref_a)
/// - both set              → `diff <ref_a> <ref_b>`   (ref_b relative to ref_a)
fn folder_diff_args(ref_a: &str, ref_b: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let a = ref_a.trim();
    let b = ref_b.trim();
    if a.is_empty() && b.is_empty() {
        args.push("HEAD".to_string());
    } else if b.is_empty() {
        args.push(a.to_string());
    } else {
        args.push(a.to_string());
        args.push(b.to_string());
    }
    args
}

/// Recursively sort children: folders before files, then alphabetical by name.
fn sort_node(node: &mut FolderDiffNode) {
    node.children.sort_by(|a, b| {
        let a_is_folder = a.kind == "folder";
        let b_is_folder = b.kind == "folder";
        match (a_is_folder, b_is_folder) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    for c in node.children.iter_mut() {
        sort_node(c);
    }
}

/// Recursive tree-walker that inserts a file change.
///
/// On each call we update the aggregates on `node` (one hop's worth),
/// then recurse into (or create) the child for `segments[0]`. When
/// `segments` is empty we've arrived at the file node itself and can
/// stamp the file-specific fields.
///
/// Using recursion instead of a mutable cursor loop avoids the classic
/// "reborrow-into-own-field" pattern that's brittle under the borrow
/// checker for tree mutations.
fn insert_segments(
    node: &mut FolderDiffNode,
    segments: &[&str],
    depth: usize,
    total_segments: usize,
    path_so_far: &str,
    change: &RawFileChange,
) {
    // Every node on the path (including the synthetic root) aggregates
    // this change. File nodes override `files_changed` below.
    node.files_changed = node.files_changed.saturating_add(1);
    node.additions = node.additions.saturating_add(change.additions);
    node.deletions = node.deletions.saturating_add(change.deletions);

    if segments.is_empty() {
        // We've arrived at the leaf (file) — set file-specific fields.
        // Guard against an empty path (shouldn't happen in practice, but
        // don't mutate the synthetic root's kind in that case).
        if depth > 0 {
            node.status = Some(change.status.clone());
            node.old_path = change.old_path.clone();
            node.binary = change.binary;
            // A file's files_changed is 1 by definition.
            node.files_changed = 1;
        }
        return;
    }

    let seg = segments[0];
    let remaining = &segments[1..];
    let is_last_seg = remaining.is_empty();

    let full_path = if path_so_far.is_empty() {
        seg.to_string()
    } else {
        format!("{}/{}", path_so_far, seg)
    };

    let idx = match node.children.iter().position(|c| c.name == seg) {
        Some(i) => i,
        None => {
            node.children.push(FolderDiffNode {
                path: full_path.clone(),
                name: seg.to_string(),
                kind: if is_last_seg { "file".to_string() } else { "folder".to_string() },
                status: None,
                old_path: None,
                files_changed: 0,
                additions: 0,
                deletions: 0,
                binary: false,
                children: Vec::new(),
            });
            node.children.len() - 1
        }
    };

    // Tail-recurse into the child; Rust's borrow checker is happy because
    // we hand it a fresh `&mut` to a single child each call.
    let _ = total_segments;
    insert_segments(
        &mut node.children[idx],
        remaining,
        depth + 1,
        total_segments,
        &full_path,
        change,
    );
}

/// Public entry: insert a file change, starting from the synthetic root.
fn insert_change(root: &mut FolderDiffNode, change: &RawFileChange) {
    let segments: Vec<&str> = change.new_path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return;
    }
    let total = segments.len();
    insert_segments(root, &segments, 0, total, "", change);
}

#[tauri::command]
fn folder_diff(cwd: String, ref_a: String, ref_b: String) -> Result<FolderDiffNode, String> {
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
    let ns_output = std::process::Command::new(git_binary())
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
    let ns2_output = std::process::Command::new(git_binary())
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

/// Folder names that, when they appear as direct children of the user's
/// home directory on macOS, are protected by TCC (Transparency, Consent,
/// Control) and would trigger a permission prompt whenever we touch
/// their contents — including a mere `.join(".git").exists()` probe.
/// We skip the git-repo probe for these to avoid the prompt loop; the
/// user can still navigate inside them and we'll probe children there.
const MACOS_TCC_PROTECTED: &[&str] = &[
    "Documents",
    "Desktop",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Library",
];

#[tauri::command]
fn list_dir(path: Option<String>) -> Result<ListDirResult, String> {
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

// ─── Git split commit ────────────────────────────────────────

#[derive(Serialize)]
struct GitSplitCommitResult {
    first_hash: String,
    second_hash: String,
}

/// Split the HEAD commit into two commits.
///
/// Expects a clean working tree on entry (no unstaged/untracked changes).
/// Workflow:
///   1. Save original HEAD SHA for rollback
///   2. `git reset --mixed HEAD^` — undo the commit, changes become unstaged
///   3. `git apply --cached --unidiff-zero` with `first_patch` — stage selected hunks
///   4. `git commit -m first_message` — create commit A (new parent)
///   5. `git add -A .` — stage everything remaining (the inverse of first_patch)
///   6. `git commit -m second_message` — create commit B (remaining changes)
///
/// On any failure after step 2, `git reset --hard <original_sha>` restores state.
/// When called from a rebase-edit-stop context, the rebase state is preserved:
/// caller is expected to run `git rebase --continue` afterwards.
#[tauri::command]
fn git_split_commit(
    cwd: String,
    first_patch: String,
    first_message: String,
    second_message: String,
) -> Result<GitSplitCommitResult, String> {
    // Step 1: save original HEAD SHA for rollback
    let original_sha = {
        let output = std::process::Command::new(git_binary())
            .args(["rev-parse", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to read HEAD: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git rev-parse HEAD failed: {}", stderr));
        }
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };

    // Helper: rollback on failure. Best-effort — we surface the original error.
    let rollback = |cwd: &str, sha: &str| {
        let _ = std::process::Command::new(git_binary())
            .args(["reset", "--hard", sha])
            .current_dir(cwd)
            .output();
    };

    // Precondition: working tree must be clean. Otherwise reset --mixed HEAD^
    // would blend unstaged changes with the commit being split.
    {
        let output = std::process::Command::new(git_binary())
            .args(["status", "--porcelain"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to read status: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            return Err(
                "Working tree must be clean before splitting a commit — \
                 commit, stash, or discard your changes first."
                    .to_string(),
            );
        }
    }

    // Precondition: HEAD must be a non-merge commit. `git reset --mixed HEAD^`
    // on a merge would silently follow the first-parent only and drop the
    // second parent from history — flattening the merge. Refuse outright.
    {
        let output = std::process::Command::new(git_binary())
            .args(["rev-list", "--parents", "-n", "1", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to read HEAD parents: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git rev-list failed: {}", stderr));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Output format: "<sha> <parent1> [<parent2> …]" — one commit per line.
        let tokens: Vec<&str> = stdout.split_whitespace().collect();
        let parent_count = tokens.len().saturating_sub(1);
        if parent_count == 0 {
            return Err(
                "Cannot split the root commit — it has no parent to reset onto."
                    .to_string(),
            );
        }
        if parent_count > 1 {
            return Err(
                "Cannot split a merge commit — splitting would flatten the merge \
                 and drop one of its parents from history."
                    .to_string(),
            );
        }
    }

    // Step 2: reset --mixed HEAD^ — changes from the commit become unstaged
    {
        let output = std::process::Command::new(git_binary())
            .args(["reset", "--mixed", "HEAD^"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to run git reset: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "git reset --mixed HEAD^ failed (does the commit have a parent?): {}",
                stderr
            ));
        }
    }

    // Step 3: stage the first patch (selected hunks)
    {
        let mut cmd = std::process::Command::new(git_binary());
        cmd.args(["apply", "--cached", "--unidiff-zero", "-"])
            .current_dir(&cwd)
            .stdin(std::process::Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                rollback(&cwd, &original_sha);
                return Err(format!("Failed to run git apply: {}", e));
            }
        };
        if let Some(ref mut stdin) = child.stdin {
            use std::io::Write;
            if let Err(e) = stdin.write_all(first_patch.as_bytes()) {
                rollback(&cwd, &original_sha);
                return Err(format!("Failed to write patch: {}", e));
            }
        }
        let output = match child.wait_with_output() {
            Ok(o) => o,
            Err(e) => {
                rollback(&cwd, &original_sha);
                return Err(format!("Failed to wait for git apply: {}", e));
            }
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            rollback(&cwd, &original_sha);
            return Err(format!(
                "git apply failed while staging first patch: {}",
                stderr
            ));
        }
    }

    // Step 4: create commit A
    let first_hash = {
        let output = std::process::Command::new(git_binary())
            .args(["commit", "-m", &first_message])
            .current_dir(&cwd)
            .output()
            .map_err(|e| {
                rollback(&cwd, &original_sha);
                format!("Failed to run git commit (first): {}", e)
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            rollback(&cwd, &original_sha);
            return Err(format!("git commit failed (first): {}", stderr));
        }
        let hash_output = std::process::Command::new(git_binary())
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to read first hash: {}", e))?;
        String::from_utf8_lossy(&hash_output.stdout).trim().to_string()
    };

    // Step 5: stage everything remaining (working tree ↔ index = inverse of first_patch)
    {
        let output = std::process::Command::new(git_binary())
            .args(["add", "-A", "."])
            .current_dir(&cwd)
            .output()
            .map_err(|e| {
                rollback(&cwd, &original_sha);
                format!("Failed to run git add: {}", e)
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            rollback(&cwd, &original_sha);
            return Err(format!("git add -A failed: {}", stderr));
        }
    }

    // Step 6: create commit B with the remaining hunks
    let second_hash = {
        let output = std::process::Command::new(git_binary())
            .args(["commit", "-m", &second_message])
            .current_dir(&cwd)
            .output()
            .map_err(|e| {
                rollback(&cwd, &original_sha);
                format!("Failed to run git commit (second): {}", e)
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // If step 6 fails (e.g. empty commit), roll back all the way
            // so caller sees the repo unchanged rather than a half-split.
            rollback(&cwd, &original_sha);
            return Err(format!("git commit failed (second): {}", stderr));
        }
        let hash_output = std::process::Command::new(git_binary())
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to read second hash: {}", e))?;
        String::from_utf8_lossy(&hash_output.stdout).trim().to_string()
    };

    Ok(GitSplitCommitResult {
        first_hash,
        second_hash,
    })
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
fn git_push(cwd: String, set_upstream: Option<bool>) -> Result<GitPushPullResult, String> {
    let mut args: Vec<&str> = vec!["push"];
    if set_upstream.unwrap_or(false) {
        // Publish the current branch to origin with the same name and set upstream
        args.extend(["--set-upstream", "origin", "HEAD"]);
    }
    let output = std::process::Command::new(git_binary())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
            // git push prints most info to stderr; prefer it when stdout is empty
            let trimmed_out = stdout.trim();
            if trimmed_out.is_empty() {
                stderr.trim().to_string()
            } else {
                trimmed_out.to_string()
            }
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
    // Extended-header state tracked per file, captured before any @@ hunk and
    // flushed alongside the file's hunks when the next `diff --git` appears.
    let mut current_status: Option<String> = None;
    let mut current_old_path: Option<String> = None;

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
                    status: current_status.take(),
                    old_path: current_old_path.take(),
                });
            }
            current_status = None;
            current_old_path = None;

            // Extract file path from "diff --git a/path b/path"
            let parts: Vec<&str> = line.split(" b/").collect();
            if parts.len() >= 2 {
                current_path = Some(parts[1].to_string());
            }
        } else if line.starts_with("new file mode") {
            current_status = Some("added".to_string());
        } else if line.starts_with("deleted file mode") {
            current_status = Some("deleted".to_string());
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            current_status = Some("renamed".to_string());
            current_old_path = Some(rest.to_string());
        } else if line.starts_with("rename to ") {
            if current_status.is_none() {
                current_status = Some("renamed".to_string());
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
            } else if line.starts_with(' ') {
                // Only accept lines that start with a literal space as context.
                // Empty strings (from split on blank separator lines or trailing
                // EOF newline) must NOT be classified as context — doing so adds
                // a phantom zero-length context line to the hunk, which makes
                // `git apply` reject the patch with "depends on old contents"
                // for new-file hunks (header becomes `-0,1` instead of `-0,0`).
                hunk.lines.push(DiffLine {
                    r#type: "context".to_string(),
                    content: line[1..].to_string(),
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
            status: current_status.take(),
            old_path: current_old_path.take(),
        });
    }

    Ok(diffs)
}

// ─── Git branches ────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitBranch {
    name: String,
    is_current: bool,
    is_remote: bool,
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
    last_commit: String,
    last_commit_date: String,
}

// ─── Git blame (v1.9) ─────────────────────────────────────

#[derive(serde::Serialize)]
struct BlameLine {
    hash: String,
    hash_full: String,
    final_line: u32,
    orig_line: u32,
    author: String,
    author_date: String,
    summary: String,
    content: String,
}

// ─── File log (v1.9) — pickaxe + line-range ──────────────

#[derive(serde::Serialize)]
struct FileLogEntry {
    hash_full: String,
    hash: String,
    author: String,
    date: String,
    message: String,
    body: String,
}

fn parse_file_log_output(raw: &str) -> Vec<FileLogEntry> {
    let sep = "---END---";
    let mut entries = Vec::new();
    for block in raw.split(sep) {
        let trimmed = block.trim();
        if trimmed.is_empty() { continue; }
        let parts: Vec<&str> = trimmed.splitn(6, '\n').collect();
        if parts.len() < 5 { continue; }
        entries.push(FileLogEntry {
            hash_full: parts[0].trim().to_string(),
            hash: parts[1].trim().to_string(),
            author: parts[2].trim().to_string(),
            date: parts[3].trim().to_string(),
            message: parts[4].trim().to_string(),
            body: parts.get(5).map(|s| s.trim().to_string()).unwrap_or_default(),
        });
    }
    entries
}

/// Standard file log (git log --follow).
#[tauri::command]
fn git_file_log(cwd: String, path: String, count: Option<u32>) -> Result<Vec<FileLogEntry>, String> {
    let n = count.unwrap_or(50).to_string();
    let fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
    let output = std::process::Command::new(git_binary())
        .args(["log", "--follow", "-n", &n, &format!("--format={}", fmt), "--", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git log failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("git log failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(parse_file_log_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Pickaxe: find commits that added or removed `search` string.
/// mode: "S" (literal string) | "G" (regex)
#[tauri::command]
fn git_file_log_pickaxe(cwd: String, path: String, search: String, mode: String) -> Result<Vec<FileLogEntry>, String> {
    let flag = if mode == "G" { "-G" } else { "-S" };
    let fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
    let output = std::process::Command::new(git_binary())
        .args(["log", "--follow", flag, &search, &format!("--format={}", fmt), "--", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git log pickaxe failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("git log pickaxe failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(parse_file_log_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Line-range history: commits that touched lines [start..end] in path.
/// Uses git log -L <start>,<end>:<path> (no --follow; incompatible with -L).
#[tauri::command]
fn git_file_log_range(cwd: String, path: String, start_line: u32, end_line: u32) -> Result<Vec<FileLogEntry>, String> {
    let range = format!("{},{}:{}", start_line, end_line, path);
    let fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
    let output = std::process::Command::new(git_binary())
        .args(["log", "-L", &range, &format!("--format={}", fmt)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git log -L failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("git log -L failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(parse_file_log_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Run `git blame --porcelain` on a file.
/// algorithm: "histogram" | "patience" | "minimal" | "myers" (default "histogram").
#[tauri::command]
fn git_blame(cwd: String, path: String, algorithm: Option<String>) -> Result<Vec<BlameLine>, String> {
    let algo = algorithm.as_deref().unwrap_or("histogram");
    let diff_algo_flag = format!("--diff-algorithm={}", algo);
    let output = std::process::Command::new(git_binary())
        .args(["blame", "--porcelain", &diff_algo_flag, "--", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git blame: {}", e))?;
    if !output.status.success() {
        return Err(format!("git blame failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = raw.lines().collect();
    let mut blame_lines: Vec<BlameLine> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        // Header: <40-char-sha> <orig-line> <final-line> [<num-lines-in-group>]
        let parts: Vec<&str> = lines[i].split_whitespace().collect();
        if parts.len() < 3 || parts[0].len() != 40 {
            i += 1;
            continue;
        }
        let hash_full = parts[0].to_string();
        let hash = hash_full[..7].to_string();
        let orig_line: u32 = parts[1].parse().unwrap_or(0);
        let final_line: u32 = parts[2].parse().unwrap_or(0);
        i += 1;
        let mut author = String::new();
        let mut author_date = String::new();
        let mut summary = String::new();
        let mut content = String::new();
        while i < lines.len() && !lines[i].starts_with('\t') {
            if lines[i].starts_with("author ") {
                author = lines[i][7..].to_string();
            } else if lines[i].starts_with("author-time ") {
                author_date = lines[i][12..].to_string();
            } else if lines[i].starts_with("summary ") {
                summary = lines[i][8..].to_string();
            }
            i += 1;
        }
        if i < lines.len() && lines[i].starts_with('\t') {
            content = lines[i][1..].to_string();
            i += 1;
        }
        blame_lines.push(BlameLine { hash, hash_full, final_line, orig_line, author, author_date, summary, content });
    }
    Ok(blame_lines)
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
fn git_create_branch(cwd: String, name: String, checkout: bool, start_point: Option<String>) -> Result<(), String> {
    if checkout {
        let mut args = vec!["checkout", "-b", &name];
        if let Some(ref sp) = start_point { args.push(sp); }
        let output = std::process::Command::new(git_binary())
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout -b failed: {}", stderr));
        }
    } else {
        let mut args = vec!["branch", &name];
        if let Some(ref sp) = start_point { args.push(sp); }
        let output = std::process::Command::new(git_binary())
            .args(&args)
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

#[tauri::command]
fn git_rename_branch(cwd: String, old_name: String, new_name: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["branch", "-m", &old_name, &new_name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to rename branch: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch -m failed: {}", stderr));
    }
    Ok(())
}

// ─── Git stash ────────────────────────────────────────────

#[tauri::command]
fn git_stash(cwd: String, message: Option<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked"];
    let trimmed = message.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(m) = trimmed {
        args.push("-m");
        args.push(m);
    }
    let output = std::process::Command::new(git_binary())
        .args(&args)
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

// ─── Commit context menu operations (v1.9) ───────────────

/// Checkout a specific commit — puts the repo in detached HEAD state.
#[tauri::command]
fn git_checkout_commit(cwd: String, sha: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["checkout", &sha])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to checkout commit: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Reset the current branch HEAD to a specific commit.
/// mode: "soft" | "mixed" | "hard"
#[tauri::command]
fn git_reset_to_commit(cwd: String, sha: String, mode: String) -> Result<(), String> {
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    let output = std::process::Command::new(git_binary())
        .args(["reset", flag, &sha])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to reset: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git reset {} failed: {}",
            flag,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Revert a commit — creates a new commit that undoes the changes.
/// For merge commits pass mainline = Some(1) to use -m 1.
#[tauri::command]
fn git_revert_commit(cwd: String, sha: String, mainline: Option<u32>) -> Result<GitPushPullResult, String> {
    let mut args = vec!["revert".to_string(), "--no-edit".to_string()];
    if let Some(m) = mainline {
        args.push("-m".to_string());
        args.push(m.to_string());
    }
    args.push(sha);
    let output = std::process::Command::new(git_binary())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to revert commit: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let has_conflicts = stderr.contains("CONFLICT") || stdout.contains("CONFLICT");
    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() { stdout } else { stderr },
        conflicts: Some(has_conflicts),
    })
}

/// Create a lightweight or annotated tag at a specific commit SHA.
#[tauri::command]
fn git_create_tag(cwd: String, name: String, sha: String, message: Option<String>) -> Result<(), String> {
    let trimmed = message.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let args: Vec<String> = if let Some(m) = trimmed {
        vec!["tag".into(), "-a".into(), name, sha, "-m".into(), m.to_string()]
    } else {
        vec!["tag".into(), name, sha]
    };
    let output = std::process::Command::new(git_binary())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to create tag: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git tag failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

// ─── Tags manager (v1.9) ─────────────────────────────────

#[derive(serde::Serialize)]
struct TagEntry {
    name: String,
    hash: String,       // commit SHA (dereferenced for annotated tags)
    is_annotated: bool,
    date: String,       // tagger date (annotated) or committer date (lightweight)
    message: String,    // subject line (annotated) or empty
}

/// List all local tags, sorted by version then by date (newest first).
#[tauri::command]
fn git_list_tags(cwd: String) -> Result<Vec<TagEntry>, String> {
    // --format uses \x1f (unit separator) as field separator — same as git_log, never appears in refs/dates
    // %(objecttype): "tag" for annotated, "commit" for lightweight
    // %(*objectname:short): dereferenced commit hash for annotated (empty for lightweight)
    let sep = "\x1f";
    let fmt = format!(
        "%(refname:short){s}%(objecttype){s}%(objectname:short){s}%(*objectname:short){s}%(taggerdate:iso){s}%(creatordate:iso){s}%(contents:subject)",
        s = sep
    );
    let output = std::process::Command::new(git_binary())
        .args(["tag", "-l", "--sort=-version:refname", "--sort=-creatordate", &format!("--format={}", fmt)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list tags: {}", e))?;
    if !output.status.success() {
        return Err(format!("git tag failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut tags = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 7 { continue; }
        let name = parts[0].trim().to_string();
        if name.is_empty() { continue; }
        let obj_type = parts[1].trim();
        let is_annotated = obj_type == "tag";
        // For annotated tags, the commit is the dereferenced object; for lightweight it's the direct object.
        let hash = if is_annotated && !parts[3].trim().is_empty() {
            parts[3].trim().to_string()
        } else {
            parts[2].trim().to_string()
        };
        let date = if is_annotated && !parts[4].trim().is_empty() {
            parts[4].trim().to_string()
        } else {
            parts[5].trim().to_string()
        };
        let message = parts[6].trim().to_string();
        tags.push(TagEntry { name, hash, is_annotated, date, message });
    }
    Ok(tags)
}

/// Delete a local tag.
#[tauri::command]
fn git_delete_tag(cwd: String, name: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["tag", "-d", &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete tag: {}", e))?;
    if !output.status.success() {
        return Err(format!("git tag -d failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// Push tags to a remote. mode: "all" (--tags) | "follow" (--follow-tags) | "single" (push one tag by name).
#[tauri::command]
fn git_push_tags(cwd: String, remote: String, mode: String, tag_name: Option<String>) -> Result<(), String> {
    let mut args = vec!["push".to_string(), remote.clone()];
    match mode.as_str() {
        "single" => {
            if let Some(name) = tag_name {
                args.push(name);
            } else {
                return Err("tag_name required for mode=single".into());
            }
        }
        "follow" => args.push("--follow-tags".to_string()),
        _ => args.push("--tags".to_string()),  // "all" is the default
    }
    let output = std::process::Command::new(git_binary())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to push tags: {}", e))?;
    if !output.status.success() {
        return Err(format!("git push tags failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// Delete a tag on a remote (git push <remote> --delete <tag>).
#[tauri::command]
fn git_delete_remote_tag(cwd: String, remote: String, name: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["push", &remote, "--delete", &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete remote tag: {}", e))?;
    if !output.status.success() {
        return Err(format!("git push --delete failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
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
    reviewers: Option<Vec<String>>,
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

    // Reviewers: gh expects a single comma-separated --reviewer list
    // (GitHub usernames or org/team-slug).
    if let Some(revs) = reviewers {
        let cleaned: Vec<String> = revs
            .into_iter()
            .map(|r| r.trim().trim_start_matches('@').to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if !cleaned.is_empty() {
            args.push("--reviewer".to_string());
            args.push(cleaned.join(","));
        }
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

/// Reviewer candidate (assignable user on the GitHub repo).
#[derive(serde::Serialize)]
struct ReviewerCandidate {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

/// List candidate reviewers for the current repo using `gh` CLI.
///
/// Calls `gh api /repos/:owner/:repo/assignees` (paginated) which returns
/// users with push access — exactly the set GitHub allows as reviewers.
#[tauri::command]
fn gh_list_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    // Discover owner/repo from the current repo.
    let view = std::process::Command::new("gh")
        .args(["repo", "view", "--json", "owner,name"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to inspect repo: {}", e))?;
    if !view.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&view.stderr)
        ));
    }
    #[derive(serde::Deserialize)]
    struct OwnerLogin { login: String }
    #[derive(serde::Deserialize)]
    struct RepoView { owner: OwnerLogin, name: String }
    let repo: RepoView = serde_json::from_slice(&view.stdout)
        .map_err(|e| format!("Failed to parse repo view: {}", e))?;
    let endpoint = format!("/repos/{}/{}/assignees", repo.owner.login, repo.name);

    // Fetch up to ~300 candidates (3 pages of 100). Plenty for typical repos.
    let output = std::process::Command::new("gh")
        .args([
            "api",
            "--paginate",
            "-H", "Accept: application/vnd.github+json",
            &endpoint,
            "--jq", "[.[] | {login: .login, name: .name, avatar_url: .avatar_url}]",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list reviewer candidates: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api assignees failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // --paginate concatenates JSON arrays page-by-page (one per line).
    // Parse each non-empty line as a JSON array and flatten.
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut all: Vec<ReviewerCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in raw.split('\n') {
        let trimmed = chunk.trim();
        if trimmed.is_empty() { continue; }
        // gh might return either a single array per chunk (--jq with array wrapper)
        // or NDJSON of arrays. Try to parse as Value and walk.
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(arr) = value.as_array() {
            for item in arr {
                let login = item.get("login").and_then(|v| v.as_str()).unwrap_or("");
                if login.is_empty() || !seen.insert(login.to_string()) { continue; }
                all.push(ReviewerCandidate {
                    login: login.to_string(),
                    name: item.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    avatar_url: item.get("avatar_url").and_then(|v| v.as_str()).map(|s| s.to_string()),
                });
            }
        }
    }
    // Sort alphabetically by login for stable UX.
    all.sort_by(|a, b| a.login.to_lowercase().cmp(&b.login.to_lowercase()));
    Ok(all)
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

// ─── Claude Code CLI (piggyback on user's local install) ─────
//
// Wraps the official `claude` CLI (Claude Code) so GitWand can use the
// user's existing Claude Max/Pro subscription without implementing OAuth
// ourselves. Inspired by Solo's approach, but headless (no PTY): we only
// need one-shot prompts for commit messages, merge resolution and PR review.

#[derive(Serialize)]
struct ClaudeCliInfo {
    found: bool,
    /// Absolute path of the resolved binary (empty when `found == false`).
    path: String,
    /// Raw `claude --version` output (e.g. "2.0.14 (Claude Code)").
    version: String,
    /// True if `claude -p "ping"` answered without an auth error.
    logged_in: bool,
    /// Human-readable status: "ok", "not_found", "not_logged_in", "error".
    status: String,
    /// Optional detail line surfaced to the UI on errors.
    detail: String,
}

/// Environment variables that make the Claude Code CLI fall back to
/// API-key auth instead of using the OAuth session from `claude login`.
/// When the user explicitly picks the "Claude Code CLI" provider in GitWand,
/// they've asked to use their Max/Pro subscription — so we strip these to
/// avoid a stale/invalid key in the shell hijacking the call.
const CLAUDE_AUTH_OVERRIDE_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
];

/// Apply the API-key env strip to a `std::process::Command` before spawning.
fn strip_claude_auth_env(cmd: &mut std::process::Command) {
    for var in CLAUDE_AUTH_OVERRIDE_ENV {
        cmd.env_remove(var);
    }
}

/// Resolve the path to the `claude` binary, checking the usual install
/// locations on macOS / Linux / Windows in addition to PATH.
fn resolve_claude_binary() -> Option<String> {
    // 1) Try PATH first via `which` / `where`.
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = std::process::Command::new(which_cmd).arg("claude").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Fall back to common install locations.
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".claude/local/claude"));
        candidates.push(h.join(".local/bin/claude"));
        candidates.push(h.join(".npm-global/bin/claude"));
        // Windows npm global
        candidates.push(h.join("AppData/Roaming/npm/claude.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/usr/bin/claude"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

// ─── Worktrees ────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
    pub is_locked: bool,
    pub is_bare: bool,
}

/// List all git worktrees via `git worktree list --porcelain`.
#[tauri::command]
fn git_worktree_list(cwd: String) -> Result<Vec<WorktreeEntry>, String> {
    let output = std::process::Command::new(git_binary())
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    let mut is_first = true;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            // Flush previous entry
            if let Some(e) = current.take() {
                entries.push(e);
            }
            let path = line["worktree ".len()..].to_string();
            current = Some(WorktreeEntry {
                path,
                branch: String::new(),
                head: String::new(),
                is_main: is_first,
                is_locked: false,
                is_bare: false,
            });
            is_first = false;
        } else if let Some(ref mut e) = current {
            if line.starts_with("HEAD ") {
                e.head = line["HEAD ".len()..].to_string();
            } else if line.starts_with("branch ") {
                // "refs/heads/main" → "main"
                let full = &line["branch ".len()..];
                e.branch = full.strip_prefix("refs/heads/").unwrap_or(full).to_string();
            } else if line == "bare" {
                e.is_bare = true;
            } else if line.starts_with("locked") {
                e.is_locked = true;
            } else if line == "detached" {
                e.branch = "(detached HEAD)".to_string();
            }
        }
    }
    // Flush last entry
    if let Some(e) = current {
        entries.push(e);
    }

    Ok(entries)
}

/// Add a new worktree. Creates `new_branch` if provided, otherwise checks out
/// the existing `branch`.
#[tauri::command]
fn git_worktree_add(
    cwd: String,
    path: String,
    branch: String,
    new_branch: Option<String>,
) -> Result<WorktreeEntry, String> {
    let mut cmd = std::process::Command::new(git_binary());
    cmd.arg("worktree").arg("add").arg(&path);

    if let Some(ref nb) = new_branch {
        cmd.arg("-b").arg(nb).arg(&branch);
    } else {
        cmd.arg(&branch);
    }

    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to add worktree: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let resolved_branch = new_branch.as_deref().unwrap_or(&branch).to_string();
    Ok(WorktreeEntry {
        path,
        branch: resolved_branch,
        head: String::new(),
        is_main: false,
        is_locked: false,
        is_bare: false,
    })
}

/// Remove a worktree. Pass `force = true` to remove even with local changes.
#[tauri::command]
fn git_worktree_remove(cwd: String, path: String, force: Option<bool>) -> Result<(), String> {
    let mut cmd = std::process::Command::new(git_binary());
    cmd.arg("worktree").arg("remove");
    if force.unwrap_or(false) {
        cmd.arg("--force");
    }
    cmd.arg(&path);

    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to remove worktree: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Prune stale worktree administrative files.
#[tauri::command]
fn git_worktree_prune(cwd: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["worktree", "prune"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to prune worktrees: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree prune failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

// ─── Submodules ───────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct SubmoduleEntry {
    pub path: String,
    pub url: String,
    pub sha: String,
    pub branch: Option<String>,
    /// "clean" | "modified" | "uninitialized"
    pub status: String,
}

/// List all submodules declared in .gitmodules, enriched with live status.
/// Returns an empty Vec if the repo has no submodules.
#[tauri::command]
fn git_submodule_list(cwd: String) -> Result<Vec<SubmoduleEntry>, String> {
    // Fast-exit if .gitmodules does not exist
    let gitmodules = std::path::Path::new(&cwd).join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(Vec::new());
    }

    // Get URLs and optional branch from git config
    let cfg_out = std::process::Command::new(git_binary())
        .args(["config", "--file", ".gitmodules", "--list"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to read .gitmodules: {}", e))?;

    // Build path → (url, branch) map
    let mut url_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut branch_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if cfg_out.status.success() {
        for line in String::from_utf8_lossy(&cfg_out.stdout).lines() {
            // submodule.<name>.url=<val>  or  submodule.<name>.path=<val>
            if let Some(eq) = line.find('=') {
                let key = &line[..eq];
                let val = &line[eq + 1..];
                if key.ends_with(".url") {
                    // We'll re-key by path after, for now store by name
                    let name = key
                        .strip_prefix("submodule.")
                        .and_then(|s| s.strip_suffix(".url"))
                        .unwrap_or(key);
                    url_map.insert(name.to_string(), val.to_string());
                } else if key.ends_with(".branch") {
                    let name = key
                        .strip_prefix("submodule.")
                        .and_then(|s| s.strip_suffix(".branch"))
                        .unwrap_or(key);
                    branch_map.insert(name.to_string(), val.to_string());
                }
            }
        }
    }

    // Build path→name map from .gitmodules (submodule.<name>.path=<path>)
    let mut path_to_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if cfg_out.status.success() {
        for line in String::from_utf8_lossy(&cfg_out.stdout).lines() {
            if let Some(eq) = line.find('=') {
                let key = &line[..eq];
                let val = &line[eq + 1..];
                if key.ends_with(".path") {
                    let name = key
                        .strip_prefix("submodule.")
                        .and_then(|s| s.strip_suffix(".path"))
                        .unwrap_or(key);
                    path_to_name.insert(val.to_string(), name.to_string());
                }
            }
        }
    }

    // `git submodule status` — one line per submodule:
    //   ' <sha> <path> (<describe>)'  → initialized, clean
    //   '+<sha> <path> (<describe>)'  → initialized, modified (different SHA)
    //   '-<sha> <path>'               → not initialized
    //   'U<sha> <path>'               → merge conflict
    let status_out = std::process::Command::new(git_binary())
        .args(["submodule", "status"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get submodule status: {}", e))?;

    let mut entries: Vec<SubmoduleEntry> = Vec::new();

    for line in String::from_utf8_lossy(&status_out.stdout).lines() {
        if line.len() < 42 {
            continue;
        }
        let prefix = &line[..1];
        let rest = &line[1..];
        let mut parts = rest.splitn(2, ' ');
        let sha = parts.next().unwrap_or("").to_string();
        let path_and_rest = parts.next().unwrap_or("");
        // path may be followed by " (<describe>)"
        let path = path_and_rest
            .split_once(' ')
            .map(|(p, _)| p)
            .unwrap_or(path_and_rest)
            .to_string();

        let status = match prefix {
            "-" => "uninitialized",
            "+" => "modified",
            _ => "clean",
        }
        .to_string();

        let name = path_to_name.get(&path).cloned().unwrap_or_else(|| path.clone());
        let url = url_map.get(&name).cloned().unwrap_or_default();
        let branch = branch_map.get(&name).cloned();

        entries.push(SubmoduleEntry { path, url, sha, branch, status });
    }

    Ok(entries)
}

/// Run `git submodule init` to register submodule config in the local .git/config.
#[tauri::command]
fn git_submodule_init(cwd: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["submodule", "init"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to init submodules: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git submodule init failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Run `git submodule update`, optionally with --init and --recursive.
#[tauri::command]
fn git_submodule_update(cwd: String, init: bool, recursive: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new(git_binary());
    cmd.arg("submodule").arg("update");
    if init {
        cmd.arg("--init");
    }
    if recursive {
        cmd.arg("--recursive");
    }

    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to update submodules: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git submodule update failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Add a new submodule at `path` pointing at `url`.
#[tauri::command]
fn git_submodule_add(cwd: String, url: String, path: String) -> Result<(), String> {
    let output = std::process::Command::new(git_binary())
        .args(["submodule", "add", &url, &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to add submodule: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git submodule add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
fn detect_claude_cli() -> Result<ClaudeCliInfo, String> {
    let binary = match resolve_claude_binary() {
        Some(b) => b,
        None => {
            return Ok(ClaudeCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `claude` introuvable. Installez-le avec `npm install -g @anthropic-ai/claude-code`."
                    .to_string(),
            });
        }
    };

    // Query version
    let version = std::process::Command::new(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // Ping with a tiny prompt to check auth. Timeout is enforced by the
    // caller via the Tauri command; here we just run synchronously with a
    // short output cap. The CLI exits non-zero when auth is missing.
    //
    // We strip API-key env vars here too so the detection reflects the
    // actual OAuth-session state that prompts will use — otherwise a stale
    // `ANTHROPIC_API_KEY` in the shell would mask the real auth status.
    let mut ping_cmd = std::process::Command::new(&binary);
    ping_cmd.args(["-p", "ping", "--output-format", "text"]);
    strip_claude_auth_env(&mut ping_cmd);
    let ping = ping_cmd.output();

    match ping {
        Ok(out) if out.status.success() => Ok(ClaudeCliInfo {
            found: true,
            path: binary,
            version,
            logged_in: true,
            status: "ok".to_string(),
            detail: String::new(),
        }),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let combined = if stderr.is_empty() { stdout } else { stderr };
            let lower = combined.to_lowercase();
            let looks_like_auth = lower.contains("login")
                || lower.contains("authenticat")
                || lower.contains("unauthor")
                || lower.contains("api key");
            Ok(ClaudeCliInfo {
                found: true,
                path: binary,
                version,
                logged_in: false,
                status: if looks_like_auth { "not_logged_in" } else { "error" }.to_string(),
                detail: combined,
            })
        }
        Err(e) => Ok(ClaudeCliInfo {
            found: true,
            path: binary,
            version,
            logged_in: false,
            status: "error".to_string(),
            detail: format!("Impossible d'exécuter `claude`: {}", e),
        }),
    }
}

/// Run `claude -p <prompt>` and return stdout.
///
/// The CLI already handles auth via the user's subscription — we just pipe
/// text in and get text back.
#[tauri::command]
fn claude_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    output_format: Option<String>,
) -> Result<String, String> {
    let binary = resolve_claude_binary()
        .ok_or_else(|| "Binaire `claude` introuvable".to_string())?;

    // Compose the full prompt: if a system prompt is provided, prepend it
    // as a Markdown-delimited section. `claude -p` doesn't expose a separate
    // system/user channel, so this is the simplest portable shape.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!(
                "# System\n{}\n\n# User\n{}",
                sys.trim(),
                prompt.trim()
            )
        }
        _ => prompt,
    };

    let fmt = output_format.unwrap_or_else(|| "text".to_string());

    let mut cmd = std::process::Command::new(&binary);
    cmd.args(["-p", &full_prompt, "--output-format", &fmt]);
    strip_claude_auth_env(&mut cmd);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Claude CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Codex CLI provider (v2.0) ─────────────────────────────
//
// OpenAI Codex CLI integration — mirrors the Claude Code CLI flow but
// shells out to `codex exec "<prompt>"` instead of `claude -p`. `codex
// exec` is the official non-interactive entry point (the REPL-style
// `codex` without subcommand would hang waiting for user input). No
// `--quiet` flag — it doesn't exist on `codex exec` and adding one
// fails with `unexpected argument '--quiet'`.
//
// Auth: either OAuth via `codex login` (uses ChatGPT subscription) or
// `OPENAI_API_KEY` env var. The CLI surfaces a clear error at first call
// when neither is set, so detection matches the Claude pattern: tiny ping
// prompt that exits 0 when auth works.

#[derive(serde::Serialize)]
struct CodexCliInfo {
    found: bool,
    path: String,
    version: String,
    logged_in: bool,
    status: String,
    detail: String,
}

fn resolve_codex_binary() -> Option<String> {
    // 1) PATH first
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = std::process::Command::new(which_cmd).arg("codex").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Common npm install locations
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".local/bin/codex"));
        candidates.push(h.join(".npm-global/bin/codex"));
        candidates.push(h.join("AppData/Roaming/npm/codex.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/codex"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    candidates.push(PathBuf::from("/usr/bin/codex"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

#[tauri::command]
fn detect_codex_cli() -> Result<CodexCliInfo, String> {
    let binary = match resolve_codex_binary() {
        Some(b) => b,
        None => {
            return Ok(CodexCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `codex` introuvable. Installez-le avec `npm install -g @openai/codex`."
                    .to_string(),
            });
        }
    };

    let version = std::process::Command::new(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // Lightweight ping. The CLI exits non-zero if auth (OAuth session or
    // OPENAI_API_KEY) is missing, with stderr describing the problem.
    let ping = std::process::Command::new(&binary)
        .args(["exec", "ping"])
        .output();

    match ping {
        Ok(out) if out.status.success() => Ok(CodexCliInfo {
            found: true,
            path: binary,
            version,
            logged_in: true,
            status: "ok".to_string(),
            detail: String::new(),
        }),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let combined = if stderr.is_empty() { stdout } else { stderr };
            let lower = combined.to_lowercase();
            let looks_like_auth = lower.contains("login")
                || lower.contains("authenticat")
                || lower.contains("unauthor")
                || lower.contains("api key")
                || lower.contains("openai_api_key");
            Ok(CodexCliInfo {
                found: true,
                path: binary,
                version,
                logged_in: false,
                status: if looks_like_auth {
                    "not_logged_in"
                } else {
                    "error"
                }
                .to_string(),
                detail: combined,
            })
        }
        Err(e) => Ok(CodexCliInfo {
            found: true,
            path: binary,
            version,
            logged_in: false,
            status: "error".to_string(),
            detail: format!("Impossible d'exécuter `codex`: {}", e),
        }),
    }
}

#[tauri::command]
fn codex_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let binary = resolve_codex_binary()
        .ok_or_else(|| "Binaire `codex` introuvable".to_string())?;

    // Codex CLI doesn't expose separate system/user channels; prepend the
    // system prompt as a Markdown section, same shape as the Claude flow.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    let mut cmd = std::process::Command::new(&binary);
    cmd.args(["exec", &full_prompt]);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run codex CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Codex CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Shortlog (v2.0) ───────────────────────────────────────
//
// `git shortlog -sne HEAD` returns one line per author summed over the
// entire HEAD history — way more accurate than aggregating a windowed
// `git log -n 250` (which biases toward whoever committed recently).
// Output looks like:
//   "   134\tLaurent Guitton <laurent@example.com>"
// where the leading whitespace + number is the count, then a tab, then
// "Name <email>".

#[derive(serde::Serialize)]
struct ShortlogEntry {
    name: String,
    email: String,
    count: u32,
}

fn parse_shortlog_line(line: &str) -> Option<ShortlogEntry> {
    let trimmed = line.trim_start();
    let (count_str, rest) = trimmed.split_once('\t')?;
    let count = count_str.trim().parse::<u32>().ok()?;
    // Split off the trailing "<email>"
    let rest = rest.trim();
    let lt = rest.rfind('<')?;
    let gt = rest.rfind('>')?;
    if gt <= lt {
        return None;
    }
    let name = rest[..lt].trim().to_string();
    let email = rest[lt + 1..gt].to_string();
    Some(ShortlogEntry { name, email, count })
}

#[tauri::command]
fn git_shortlog(cwd: String) -> Result<Vec<ShortlogEntry>, String> {
    let output = std::process::Command::new(git_binary())
        .args(["shortlog", "-sne", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git shortlog: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<ShortlogEntry> = stdout
        .lines()
        .filter_map(parse_shortlog_line)
        .collect();
    // `-n` already sorts by count desc, but be defensive in case git's
    // locale or future versions tweak ordering.
    entries.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(entries)
}

// ─── Clone & Fork (v2.0) ───────────────────────────────────
//
// Both commands are synchronous shell-outs that block on completion.
// Real-time progress events are deliberately deferred — they'd require
// introducing async commands + Tauri event emit + SSE on the dev-server,
// which is a chantier of its own. The frontend shows a spinner while
// these run; on a fast network a typical clone is sub-second to a few
// seconds and the spinner is acceptable.

/// Extract the bare repo name from a Git URL or `owner/repo` shorthand.
/// Used to compute the final clone path after `gh repo fork --clone`,
/// since gh doesn't accept an `--into` flag and writes to `<cwd>/<repo>`.
fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    if trimmed.is_empty() {
        return None;
    }
    let last = trimmed.rsplit(['/', ':']).next()?;
    if last.is_empty() {
        None
    } else {
        Some(last.to_string())
    }
}

/// `git clone <url> <dest>` — full clone, no progress events. `dest` must
/// be an absolute path that does not yet exist (git refuses otherwise).
#[tauri::command]
fn git_clone(url: String, dest: String) -> Result<String, String> {
    let url_trim = url.trim();
    let dest_trim = dest.trim();
    if url_trim.is_empty() {
        return Err("Empty URL".to_string());
    }
    if dest_trim.is_empty() {
        return Err("Empty destination".to_string());
    }

    let output = std::process::Command::new(git_binary())
        .args(["clone", url_trim, dest_trim])
        .output()
        .map_err(|e| format!("Failed to spawn git clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(dest_trim.to_string())
}

/// `gh repo fork <url> --clone --remote-name=upstream` — forks on GitHub
/// (creating the user's fork if needed) and clones it into `parent_dir`.
/// Returns the absolute path of the cloned directory.
#[tauri::command]
fn gh_fork(url: String, parent_dir: String) -> Result<String, String> {
    let url_trim = url.trim();
    let parent_trim = parent_dir.trim();
    if url_trim.is_empty() {
        return Err("Empty URL".to_string());
    }
    if parent_trim.is_empty() {
        return Err("Empty destination".to_string());
    }

    let repo_name = repo_name_from_url(url_trim)
        .ok_or_else(|| "Could not derive repo name from URL".to_string())?;

    let output = std::process::Command::new("gh")
        .args([
            "repo",
            "fork",
            url_trim,
            "--clone",
            "--remote-name=upstream",
        ])
        .current_dir(parent_trim)
        .output()
        .map_err(|e| format!("Failed to spawn gh: {} (is GitHub CLI installed?)", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "gh repo fork failed".to_string()
        };
        return Err(detail);
    }

    Ok(format!("{}/{}", parent_trim.trim_end_matches('/'), repo_name))
}

/// Launch `claude login` in the user's native terminal emulator. We don't
/// embed a PTY because this is a one-shot setup flow: the user validates
/// in their browser and comes back to GitWand.
#[tauri::command]
fn claude_cli_login() -> Result<(), String> {
    let binary = resolve_claude_binary()
        .ok_or_else(|| "Binaire `claude` introuvable. Installez-le d'abord.".to_string())?;

    #[cfg(target_os = "macos")]
    {
        // Open Terminal.app with the login command. `osascript` keeps the
        // window focused so the user sees the OAuth prompt in the browser
        // that Claude Code opens automatically.
        let script = format!(
            "tell application \"Terminal\" to do script \"{} login\"",
            binary.replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // cmd /k keeps the window open after login completes so the user
        // can read any status message.
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("\"{}\" login", binary)])
            .spawn()
            .map_err(|e| format!("Failed to open cmd: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Try the common Linux terminal emulators in order of popularity.
        // Each entry's last slot is where the shell command gets appended.
        let candidates: [&[&str]; 6] = [
            &["gnome-terminal", "--", "sh", "-c"],
            &["konsole", "-e", "sh", "-c"],
            &["xfce4-terminal", "-e"],
            &["kitty", "sh", "-c"],
            &["alacritty", "-e", "sh", "-c"],
            &["x-terminal-emulator", "-e", "sh", "-c"],
        ];
        let inner = format!("{} login; echo; read -p 'Press enter to close...'", binary);
        for args in candidates.iter() {
            let (prog, rest) = args.split_first().unwrap();
            let mut cmd = std::process::Command::new(prog);
            for a in rest.iter() {
                cmd.arg(a);
            }
            cmd.arg(&inner);
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err(
            "Aucun terminal compatible trouvé. Ouvrez un terminal et tapez: claude login"
                .to_string(),
        );
    }

    #[allow(unreachable_code)]
    Err("Plateforme non supportée".to_string())
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

// ─── Parity probe re-exports ───────────────────────────────
//
// `#[tauri::command]` generates a helper `pub struct __cmd__<fn_name>` next
// to the function, and making the wrapped fn itself `pub` collides with that
// helper's name in the macro namespace (E0255). So we keep the Tauri commands
// private and expose tiny `pub fn <name>_parity` wrappers that the
// `parity-probe` example (see `examples/parity_probe.rs`) imports to run the
// *same* code paths as the Tauri handler, without going through a Tauri
// `Invoke`.
//
// These wrappers are always compiled — they're 3-line passthroughs with no
// runtime cost, and keeping them unconditional avoids the "works with this
// feature, breaks without it" class of bugs.

pub fn git_status_parity(cwd: String) -> Result<GitStatus, String> {
    git_status(cwd)
}

pub fn git_log_parity(
    cwd: String,
    count: Option<i32>,
    all: Option<bool>,
    author: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    git_log(cwd, count, all, author)
}

pub fn git_branches_parity(cwd: String) -> Result<Vec<GitBranch>, String> {
    git_branches(cwd)
}

// ─── Tauri entry point ─────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Register Cmd+Shift+G (macOS) / Ctrl+Shift+G (Linux/Windows)
            // to bring GitWand to the foreground from anywhere.
            use tauri_plugin_global_shortcut::ShortcutState;
            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+G", move |_app, _shortcut, event| {
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
            read_file_at_revision,
            folder_diff,
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
            git_split_commit,
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
            git_rename_branch,
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
            gh_list_reviewer_candidates,
            gh_checkout_pr,
            gh_merge_pr,
            gh_pr_detail,
            gh_pr_diff,
            gh_pr_checks,
            git_exec,
            git_autocomplete,
            git_get_user,
            detect_claude_cli,
            claude_cli_prompt,
            claude_cli_login,
            git_worktree_list,
            git_worktree_add,
            git_worktree_remove,
            git_worktree_prune,
            git_submodule_list,
            git_submodule_init,
            git_submodule_update,
            git_submodule_add,
            git_file_log,
            git_file_log_pickaxe,
            git_file_log_range,
            git_blame,
            git_checkout_commit,
            git_reset_to_commit,
            git_revert_commit,
            git_create_tag,
            git_list_tags,
            git_delete_tag,
            git_push_tags,
            git_delete_remote_tag,
            git_clone,
            gh_fork,
            git_shortlog,
            detect_codex_cli,
            codex_cli_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitWand");
}

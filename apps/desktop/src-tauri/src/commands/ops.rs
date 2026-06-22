use crate::git::*;
use crate::types::*;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use rayon::prelude::*;

// ─── Git stage / unstage ─────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut cmd = git_cmd();
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
pub(crate) async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut cmd = git_cmd();
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
pub(crate) async fn git_stage_patch(cwd: String, patch: String) -> Result<(), String> {
    let mut cmd = git_cmd();
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
pub(crate) async fn git_unstage_patch(cwd: String, patch: String) -> Result<(), String> {
    let mut cmd = git_cmd();
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
pub(crate) async fn git_commit(
    cwd: String,
    message: String,
    identity_name: Option<String>,
    identity_email: Option<String>,
) -> Result<String, String> {
    let _t0 = Instant::now();
    let mut cmd = git_cmd();
    // Inject identity overrides before the `commit` sub-command so git sees them.
    if let (Some(ref name), Some(ref email)) = (&identity_name, &identity_email) {
        if !name.is_empty() && !email.is_empty() {
            cmd.arg("-c").arg(format!("user.name={}", name))
               .arg("-c").arg(format!("user.email={}", email));
        }
    }
    let output = cmd
        .args(["commit", "-m", &message])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git commit: {}", e))?;
    record_cmd(&format!("git commit -m {:?}", message), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {}", stderr));
    }

    // Return the new commit hash
    let log_output = git_cmd()
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    let hash = String::from_utf8_lossy(&log_output.stdout).trim().to_string();
    Ok(hash)
}

#[tauri::command]
pub(crate) async fn git_amend_commit(cwd: String, message: String) -> Result<String, String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["commit", "--amend", "-m", &message])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git commit --amend: {}", e))?;
    record_cmd(&format!("git commit --amend -m {:?}", message), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit --amend failed: {}", stderr));
    }

    let log_output = git_cmd()
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    let hash = String::from_utf8_lossy(&log_output.stdout).trim().to_string();
    Ok(hash)
}

#[tauri::command]
pub(crate) async fn git_split_commit(
    cwd: String,
    first_patch: String,
    first_message: String,
    second_message: String,
) -> Result<GitSplitCommitResult, String> {
    // Step 1: save original HEAD SHA for rollback
    let original_sha = {
        let output = git_cmd()
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
        let _ = git_cmd()
            .args(["reset", "--hard", sha])
            .current_dir(cwd)
            .output();
    };

    // Precondition: working tree must be clean. Otherwise reset --mixed HEAD^
    // would blend unstaged changes with the commit being split.
    {
        let output = git_cmd()
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
        let output = git_cmd()
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
        let output = git_cmd()
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
        let mut cmd = git_cmd();
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
        let output = git_cmd()
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
        let hash_output = git_cmd()
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to read first hash: {}", e))?;
        String::from_utf8_lossy(&hash_output.stdout).trim().to_string()
    };

    // Step 5: stage everything remaining (working tree ↔ index = inverse of first_patch)
    {
        let output = git_cmd()
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
        let output = git_cmd()
            .args(["commit", "-m", &second_message])
            .current_dir(&cwd)
            .output()
            .map_err(|e| {
                rollback(&cwd, &original_sha);
                format!("Failed to run git commit (second): {}", e)
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            rollback(&cwd, &original_sha);
            return Err(format!("git commit failed (second): {}", stderr));
        }
        let hash_output = git_cmd()
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

// ─── Git push / pull / merge ─────────────────────────────────

#[tauri::command]
pub(crate) async fn git_push(cwd: String, set_upstream: Option<bool>, force: Option<bool>) -> Result<GitPushPullResult, String> {
    let mut args: Vec<&str> = vec!["push"];
    if set_upstream.unwrap_or(false) {
        args.extend(["--set-upstream", "origin", "HEAD"]);
    }
    if force.unwrap_or(false) {
        args.push("--force-with-lease");
    }
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git push: {}", e))?;
    record_cmd(&format!("git {}", args.join(" ")), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() {
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
pub(crate) async fn git_fetch(cwd: String) -> Result<GitPushPullResult, String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["fetch", "--prune"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git fetch: {}", e))?;
    record_cmd("git fetch --prune", &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

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
pub(crate) async fn git_merge(cwd: String, branch: String) -> Result<GitPushPullResult, String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["merge", &branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git merge: {}", e))?;
    record_cmd(&format!("git merge {}", branch), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

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
pub(crate) async fn git_merge_abort(cwd: String) -> Result<GitPushPullResult, String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["merge", "--abort"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git merge --abort: {}", e))?;
    record_cmd("git merge --abort", &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

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
pub(crate) async fn git_merge_continue(cwd: String) -> Result<GitPushPullResult, String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["-c", "core.editor=true", "merge", "--continue"])
        .current_dir(&cwd)
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| format!("Failed to run git merge --continue: {}", e))?;
    record_cmd("git merge --continue", &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

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
pub(crate) async fn git_pull(cwd: String, rebase: bool) -> Result<GitPushPullResult, String> {
    let _t0 = Instant::now();
    // Pass the strategy flag EXPLICITLY so the user's pull-mode choice is
    // authoritative. A bare `git pull` defers to the ambient `pull.rebase`
    // git config, which means a user with `pull.rebase=true` would silently
    // get a rebase even when they picked "merge" in GitWand (and vice-versa).
    let strategy = if rebase { "--rebase" } else { "--no-rebase" };
    let output = git_cmd()
        .args(["pull", strategy])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git pull: {}", e))?;
    record_cmd(&format!("git pull {}", strategy), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

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

// ─── Git rebase ────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_rebase_action(cwd: String, action: String) -> Result<(), String> {
    let arg = match action.as_str() {
        "continue" | "abort" | "skip" => action.as_str(),
        _ => return Err(format!("Unknown rebase action '{}'", action)),
    };
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["rebase", &format!("--{}", arg)])
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git rebase --{}: {}", arg, e))?;
    record_cmd(&format!("git rebase --{}", arg), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git rebase --{} failed: {}", arg, msg));
    }
    Ok(())
}

/// Result of starting an interactive rebase. `conflict` is true when the rebase
/// halted on a merge conflict (the frontend then drives continue/abort/skip).
#[derive(serde::Serialize)]
pub(crate) struct InteractiveRebaseResult {
    pub conflict: bool,
}

/// Start an interactive rebase with a caller-supplied todo list.
///
/// Git's interactive rebase normally opens `$GIT_SEQUENCE_EDITOR` on the todo
/// file. We bypass the editor by pointing `GIT_SEQUENCE_EDITOR` at a `cp`/`copy`
/// command that overwrites the todo file with `todo_lines` (written to a temp
/// file we control). `GIT_EDITOR=true` neutralises any reword/commit-message
/// editor so the command never blocks waiting for input.
///
/// Security: `base` and the todo content are passed as discrete args / file
/// content — never interpolated into a shell. The only shell string is
/// `GIT_SEQUENCE_EDITOR`, and the path it embeds is a temp file *we* generate
/// (pid + nanos), not user input, so there is no injection surface.
#[tauri::command]
pub(crate) async fn git_interactive_rebase(
    cwd: String,
    base: String,
    todo_lines: Vec<String>,
) -> Result<InteractiveRebaseResult, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_file = std::env::temp_dir().join(format!(
        "gitwand-rebase-todo-{}-{}.txt",
        std::process::id(),
        nanos
    ));

    let mut content = todo_lines.join("\n");
    content.push('\n');
    std::fs::write(&tmp_file, &content)
        .map_err(|e| format!("Failed to write rebase todo file: {}", e))?;

    // GIT_SEQUENCE_EDITOR is invoked as `<editor> <todo-path>`. Use cp/copy to
    // overwrite the sequencer's todo file with ours.
    let tmp_str = tmp_file.to_string_lossy();
    let editor_cmd = if cfg!(windows) {
        format!("copy /Y \"{}\"", tmp_str)
    } else {
        format!("cp \"{}\"", tmp_str)
    };

    let _t0 = Instant::now();
    let result = git_cmd()
        .args(["rebase", "-i", &base])
        .env("GIT_SEQUENCE_EDITOR", &editor_cmd)
        .env("GIT_EDITOR", "true")
        .env("EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(&cwd)
        .output();

    // Best-effort cleanup; the temp file holds no secrets but shouldn't linger.
    let _ = std::fs::remove_file(&tmp_file);

    let output = result.map_err(|e| format!("Failed to run git rebase -i: {}", e))?;
    record_cmd(
        "git rebase -i",
        &cwd,
        _t0.elapsed().as_millis() as u64,
        output.status.code().unwrap_or(-1),
    );

    if output.status.success() {
        return Ok(InteractiveRebaseResult { conflict: false });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stderr.contains("CONFLICT") || stderr.contains("could not apply")
        || stdout.contains("CONFLICT") || stdout.contains("could not apply")
    {
        return Ok(InteractiveRebaseResult { conflict: true });
    }
    let msg = if stderr.is_empty() { stdout } else { stderr };
    Err(format!("git rebase -i failed: {}", msg))
}

// ─── Git discard ───────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_discard(cwd: String, paths: Vec<String>, untracked: bool) -> Result<(), String> {
    if untracked {
        let mut cmd = git_cmd();
        cmd.arg("clean").arg("-f").arg("--").current_dir(&cwd);
        for p in &paths {
            cmd.arg(p);
        }
        let output = cmd.output().map_err(|e| format!("Failed to run git clean: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git clean failed: {}", stderr));
        }
    } else {
        let mut cmd = git_cmd();
        cmd.arg("checkout").arg("--").current_dir(&cwd);
        for p in &paths {
            cmd.arg(p);
        }
        let output = cmd.output().map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout failed: {}", stderr));
        }
    }
    Ok(())
}

// ─── Git branches ──────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    let main_name = get_main_branch_name(&cwd);
    let output = git_cmd()
        .args([
            "branch", "-a",
            // KEEP IN SYNC with the same format/parse in dev-server.mjs
            // (handleRequest branch listing). Field order is positional — any
            // field add/reorder must be mirrored there and in the parser below.
            &format!("--format=%(HEAD)%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(objectname:short) %(subject)\x1f%(committerdate:iso-strict)\x1f%(ahead-behind:{})", main_name),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches_raw: Vec<(GitBranch, Option<String>)> = Vec::new();
    let mut main_counts: std::collections::HashMap<String, i32> = std::collections::HashMap::new();

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

        let main_count = if parts.len() > 5 {
            let ab = parts[5].split_whitespace().next().unwrap_or("0");
            ab.parse::<i32>().unwrap_or(0)
        } else {
            0
        };

        if name.contains("HEAD ->") || name == "origin/HEAD" { continue; }

        let is_remote = name.starts_with("origin/") || name.starts_with("remotes/");
        let clean_name = if name.starts_with("remotes/") {
            name.strip_prefix("remotes/").unwrap_or(&name).to_string()
        } else {
            name.clone()
        };

        main_counts.insert(clean_name.clone(), main_count);

        branches_raw.push((GitBranch {
            name: clean_name,
            is_current,
            is_remote,
            upstream: upstream.clone(),
            ahead,
            behind,
            main_commit_count: 0, // Fill later
            last_commit,
            last_commit_date,
        }, upstream));
    }

    let mut branches = Vec::new();
    for (mut b, upstream) in branches_raw {
        if b.is_remote {
            b.main_commit_count = *main_counts.get(&b.name).unwrap_or(&0);
        } else if let Some(ref u) = upstream {
            // For local branches, use the count of their upstream
            b.main_commit_count = *main_counts.get(u).unwrap_or(&0);
        } else {
            // No upstream -> 0 pushed commits
            b.main_commit_count = 0;
        }
        branches.push(b);
    }

    Ok(branches)
}

fn get_main_branch_name(cwd: &str) -> String {
    for name in ["main", "master", "origin/main", "origin/master"] {
        if let Ok(output) = git_cmd()
            .args(["rev-parse", "--verify", name])
            .current_dir(cwd)
            .output()
        {
            if output.status.success() {
                return name.to_string();
            }
        }
    }
    "main".to_string()
}

#[tauri::command]
pub(crate) async fn git_create_branch(cwd: String, name: String, checkout: bool, start_point: Option<String>) -> Result<(), String> {
    if checkout {
        let mut args = vec!["checkout", "-b", &name];
        if let Some(ref sp) = start_point { args.push(sp); }
        let _t0 = Instant::now();
        let output = git_cmd()
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        record_cmd(&format!("git {}", args.join(" ")), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout -b failed: {}", stderr));
        }
    } else {
        let mut args = vec!["branch", &name];
        if let Some(ref sp) = start_point { args.push(sp); }
        let _t0 = Instant::now();
        let output = git_cmd()
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        record_cmd(&format!("git {}", args.join(" ")), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git branch failed: {}", stderr));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_switch_branch(cwd: String, name: String) -> Result<(), String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["checkout", &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to switch branch: {}", e))?;
    record_cmd(&format!("git checkout {}", name), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git checkout failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<(), String> {
    let flag = if force { "-D" } else { "-d" };
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["branch", flag, &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete branch: {}", e))?;
    record_cmd(&format!("git branch {} {}", flag, name), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch {} failed: {}", flag, stderr));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_delete_remote_branch(cwd: String, remote: String, name: String) -> Result<(), String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["push", &remote, "--delete", &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete remote branch: {}", e))?;
    record_cmd(&format!("git push {} --delete {}", remote, name), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git push --delete failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_rename_branch(cwd: String, old_name: String, new_name: String) -> Result<(), String> {
    let output = git_cmd()
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
pub(crate) async fn git_stash(cwd: String, message: Option<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked"];
    let trimmed = message.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(m) = trimmed {
        args.push("-m");
        args.push(m);
    }
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git stash: {}", e))?;
    record_cmd(&format!("git {}", args.join(" ")), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git stash failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_stash_pop(cwd: String) -> Result<(), String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["stash", "pop"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git stash pop: {}", e))?;
    record_cmd("git stash pop", &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git stash pop failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_stash_list(cwd: String) -> Result<Vec<StashEntry>, String> {
    let output = git_cmd()
        .args(["stash", "list", "--format=%H%x00%gd%x00%gs%x00%ai"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list stashes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for (i, line) in stdout.lines().enumerate() {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() >= 4 {
            let subject = parts[2];
            // Skip internal untracked-files commits created by --include-untracked.
            if subject.starts_with("untracked files on ") {
                continue;
            }
            let (branch, message) = if subject.starts_with("On ") {
                // "On <branch>: <custom-message>"
                if let Some(colon_pos) = subject.find(": ") {
                    (subject[3..colon_pos].to_string(), subject[colon_pos + 2..].to_string())
                } else {
                    (String::new(), subject.to_string())
                }
            } else if subject.starts_with("WIP on ") {
                // "WIP on <branch>: <sha> <commit-msg>"
                if let Some(colon_pos) = subject.find(": ") {
                    let branch = subject[7..colon_pos].to_string();
                    // drop the leading "<sha> " from the commit message portion
                    let rest = &subject[colon_pos + 2..];
                    let msg = rest.splitn(2, ' ').nth(1).unwrap_or(rest).to_string();
                    (branch, msg)
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

#[tauri::command]
pub(crate) async fn git_stash_apply(cwd: String, index: usize) -> Result<(), String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["stash", "apply", &stash_ref])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to apply stash: {}", e))?;
    record_cmd(&format!("git stash apply {}", stash_ref), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        return Err(format!(
            "git stash apply failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_stash_drop(cwd: String, index: usize) -> Result<(), String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let output = git_cmd()
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

#[tauri::command]
pub(crate) async fn git_stash_clear(cwd: String) -> Result<(), String> {
    let output = git_cmd()
        .args(["stash", "clear"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git stash clear: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git stash clear failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_stash_show(cwd: String, index: usize) -> Result<String, String> {
    let stash_ref = format!("stash@{{{}}}", index);
    let output = git_cmd()
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

// ─── Cherry-pick ─────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_cherry_pick(cwd: String, hashes: Vec<String>) -> Result<GitPushPullResult, String> {
    let git = git_binary();
    let mut args = vec!["cherry-pick".to_string()];
    args.extend(hashes);

    let _t0 = Instant::now();
    let output = hidden_cmd(&git)
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git cherry-pick: {}", e))?;
    record_cmd(&format!("git {}", args.join(" ")), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let has_conflicts = stderr.contains("CONFLICT") || stderr.contains("conflict");

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() { stdout } else { stderr },
        conflicts: Some(has_conflicts),
    })
}

#[tauri::command]
pub(crate) async fn git_cherry_pick_abort(cwd: String) -> Result<(), String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["cherry-pick", "--abort"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to abort cherry-pick: {}", e))?;
    record_cmd("git cherry-pick --abort", &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        return Err(format!(
            "cherry-pick --abort failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_cherry_pick_continue(cwd: String) -> Result<GitPushPullResult, String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["cherry-pick", "--continue"])
        .current_dir(&cwd)
        .env("GIT_EDITOR", "true") // skip editor for commit message
        .output()
        .map_err(|e| format!("Failed to continue cherry-pick: {}", e))?;
    record_cmd("git cherry-pick --continue", &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() { stdout } else { stderr },
        conflicts: None,
    })
}

// ─── Commit context menu operations ─────────────────────────

#[tauri::command]
pub(crate) async fn git_checkout_commit(cwd: String, sha: String) -> Result<(), String> {
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["checkout", &sha])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to checkout commit: {}", e))?;
    record_cmd(&format!("git checkout {}", sha), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_reset_to_commit(cwd: String, sha: String, mode: String) -> Result<(), String> {
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(["reset", flag, &sha])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to reset: {}", e))?;
    record_cmd(&format!("git reset {} {}", flag, sha), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    if !output.status.success() {
        return Err(format!(
            "git reset {} failed: {}",
            flag,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_revert_commit(cwd: String, sha: String, mainline: Option<u32>) -> Result<GitPushPullResult, String> {
    let mut args = vec!["revert".to_string(), "--no-edit".to_string()];
    if let Some(m) = mainline {
        args.push("-m".to_string());
        args.push(m.to_string());
    }
    args.push(sha);
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to revert commit: {}", e))?;
    record_cmd(&format!("git {}", args.join(" ")), &cwd, _t0.elapsed().as_millis() as u64, output.status.code().unwrap_or(-1));
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let has_conflicts = stderr.contains("CONFLICT") || stdout.contains("CONFLICT");
    Ok(GitPushPullResult {
        success: output.status.success(),
        message: if output.status.success() { stdout } else { stderr },
        conflicts: Some(has_conflicts),
    })
}

// ─── Git tags ──────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_create_tag(cwd: String, name: String, sha: String, message: Option<String>) -> Result<(), String> {
    let tag_name = name.clone();
    let trimmed = message.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let args: Vec<String> = if let Some(m) = trimmed {
        vec!["tag".into(), "-a".into(), name, sha, "-m".into(), m.to_string()]
    } else {
        vec!["tag".into(), name, sha]
    };
    let output = git_cmd()
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

    // Auto-push to remote directly as requested (v2.16)
    // We try 'origin' first, then fall back to the first available remote.
    let remote = match git_cmd().args(["remote"]).current_dir(&cwd).output() {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let remotes: Vec<&str> = stdout.lines().collect();
            if remotes.contains(&"origin") {
                Some("origin".to_string())
            } else {
                remotes.first().map(|s| s.to_string())
            }
        }
        _ => None,
    };

    if let Some(r) = remote {
        // We ignore push failure if we're offline, as the local tag was already successfully created.
        let _ = git_cmd()
            .args(["push", &r, &format!("refs/tags/{}", tag_name)])
            .current_dir(&cwd)
            .output();
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn git_list_tags(cwd: String) -> Result<Vec<TagEntry>, String> {
    let sep = "\x1f";
    let fmt = format!(
        "%(refname:short){s}%(objecttype){s}%(objectname:short){s}%(*objectname:short){s}%(taggerdate:iso){s}%(creatordate:iso){s}%(contents:subject)",
        s = sep
    );
    let output = git_cmd()
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

#[tauri::command]
pub(crate) async fn git_delete_tag(cwd: String, name: String) -> Result<(), String> {
    let output = git_cmd()
        .args(["tag", "-d", &name])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete tag: {}", e))?;
    if !output.status.success() {
        return Err(format!("git tag -d failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_push_tags(cwd: String, remote: String, mode: String, tag_name: Option<String>) -> Result<(), String> {
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
        _ => args.push("--tags".to_string()),
    }
    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to push tags: {}", e))?;
    if !output.status.success() {
        return Err(format!("git push tags failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_unpushed_tags(cwd: String, remote: String) -> Result<Vec<String>, String> {
    // Local tags
    let local_out = git_cmd()
        .args(["tag", "-l"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git tag: {}", e))?;
    let local_tags: HashSet<String> = String::from_utf8_lossy(&local_out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if local_tags.is_empty() {
        return Ok(vec![]);
    }

    // Remote tags (git ls-remote --tags --refs <remote>)
    let remote_out = git_cmd()
        .args(["ls-remote", "--tags", "--refs", &remote])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git ls-remote: {}", e))?;
    let remote_tags: HashSet<String> = String::from_utf8_lossy(&remote_out.stdout)
        .lines()
        .filter_map(|l| {
            let r = l.split('\t').nth(1)?;
            Some(r.trim_start_matches("refs/tags/").trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .collect();

    let mut unpushed: Vec<String> = local_tags.difference(&remote_tags).cloned().collect();
    unpushed.sort();
    Ok(unpushed)
}

#[tauri::command]
pub(crate) async fn git_delete_remote_tag(cwd: String, remote: String, name: String) -> Result<(), String> {
    let output = git_cmd()
        .args(["push", &remote, "--delete", &format!("refs/tags/{}", name)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to delete remote tag: {}", e))?;
    if !output.status.success() {
        return Err(format!("git push --delete failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

// ─── Git conflict check ─────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_conflict_check(cwd: String, target_branch: String) -> Result<ConflictRisk, String> {
    let git = git_binary();

    let base_out = hidden_cmd(&git)
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

    let ours_files = crate::git::git_changed_files(&git, &cwd, &base, "HEAD")?;
    let theirs_files = crate::git::git_changed_files(&git, &cwd, &base, &target_branch)?;

    let ours_set: HashSet<&String> = ours_files.iter().collect();
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

// ─── Git submodules ─────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_submodule_list(cwd: String) -> Result<Vec<SubmoduleEntry>, String> {
    let gitmodules = std::path::Path::new(&cwd).join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(Vec::new());
    }

    let cfg_out = git_cmd()
        .args(["config", "--file", ".gitmodules", "--list"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to read .gitmodules: {}", e))?;

    let mut url_map: HashMap<String, String> = HashMap::new();
    let mut branch_map: HashMap<String, String> = HashMap::new();

    if cfg_out.status.success() {
        for line in String::from_utf8_lossy(&cfg_out.stdout).lines() {
            if let Some(eq) = line.find('=') {
                let key = &line[..eq];
                let val = &line[eq + 1..];
                if key.ends_with(".url") {
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

    let mut path_to_name: HashMap<String, String> = HashMap::new();
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

    let status_out = git_cmd()
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

#[tauri::command]
pub(crate) async fn git_submodule_init(cwd: String) -> Result<(), String> {
    let output = git_cmd()
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

#[tauri::command]
pub(crate) async fn git_submodule_update(cwd: String, init: bool, recursive: bool) -> Result<(), String> {
    let mut cmd = git_cmd();
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

#[tauri::command]
pub(crate) async fn git_submodule_add(cwd: String, url: String, path: String) -> Result<(), String> {
    let output = git_cmd()
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

/// List the local branches of a submodule. `submodule_path` is relative to `cwd`.
/// Used by the branch picker's "Submodules" section (v2.15.1).
#[tauri::command]
pub(crate) async fn git_submodule_branches(
    cwd: String,
    submodule_path: String,
) -> Result<Vec<SubmoduleBranch>, String> {
    let sub_dir = std::path::Path::new(&cwd).join(&submodule_path);
    if !sub_dir.exists() {
        return Ok(Vec::new());
    }

    let output = git_cmd()
        .args(["branch", "--format=%(HEAD)%(refname:short)"])
        .current_dir(&sub_dir)
        .output()
        .map_err(|e| format!("Failed to list submodule branches: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git branch (submodule) failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let mut branches: Vec<SubmoduleBranch> = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        // `%(HEAD)` emits "*" for the current branch, a space otherwise.
        let is_current = line.starts_with('*');
        let name = line.trim_start_matches('*').trim().to_string();
        if name.is_empty() {
            continue;
        }
        branches.push(SubmoduleBranch { name, is_current });
    }

    Ok(branches)
}

/// Map of commit SHA → submodule pointer changes introduced by that commit.
/// Only commits that touch a declared submodule path are returned, so the
/// scan stays cheap even on large histories (v2.15.1). Used to badge commits
/// in the Git Tree with the submodule SHA they point to.
#[tauri::command]
pub(crate) async fn git_commit_submodule_changes(
    cwd: String,
) -> Result<HashMap<String, Vec<CommitSubmoduleChange>>, String> {
    let gitmodules = std::path::Path::new(&cwd).join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(HashMap::new());
    }

    // Collect declared submodule paths from .gitmodules.
    let cfg_out = git_cmd()
        .args(["config", "--file", ".gitmodules", "--get-regexp", "path"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to read .gitmodules: {}", e))?;

    let mut sub_paths: Vec<String> = Vec::new();
    if cfg_out.status.success() {
        for line in String::from_utf8_lossy(&cfg_out.stdout).lines() {
            // "submodule.<name>.path <path>"
            if let Some((_, path)) = line.split_once(' ') {
                let p = path.trim().to_string();
                if !p.is_empty() {
                    sub_paths.push(p);
                }
            }
        }
    }
    if sub_paths.is_empty() {
        return Ok(HashMap::new());
    }

    // `git log --raw --no-abbrev -- <paths>` emits, per commit, a header line
    // we control via --format, then raw diff lines. Gitlink changes look like:
    //   :160000 160000 <oldsha> <newsha> M\t<path>
    let mut args: Vec<String> = vec![
        "log".into(),
        "--format=GWCOMMIT:%H".into(),
        "--raw".into(),
        "--no-abbrev".into(),
        "--no-renames".into(),
    ];
    args.push("--".into());
    for p in &sub_paths {
        args.push(p.clone());
    }

    let out = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to scan submodule changes: {}", e))?;

    if !out.status.success() {
        return Err(format!(
            "git log (submodule changes) failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let mut map: HashMap<String, Vec<CommitSubmoduleChange>> = HashMap::new();
    let mut current: Option<String> = None;

    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(sha) = line.strip_prefix("GWCOMMIT:") {
            current = Some(sha.to_string());
            continue;
        }
        if !line.starts_with(':') {
            continue;
        }
        // ":160000 160000 <old> <new> M\t<path>"
        let (meta, path) = match line.split_once('\t') {
            Some((m, p)) => (m, p.to_string()),
            None => continue,
        };
        let fields: Vec<&str> = meta.trim_start_matches(':').split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let src_mode = fields[0];
        let dst_mode = fields[1];
        // A submodule (gitlink) has mode 160000 on either side.
        if src_mode != "160000" && dst_mode != "160000" {
            continue;
        }
        let new_sha = fields[3];
        // Skip deletions (all-zero destination SHA).
        if new_sha.chars().all(|c| c == '0') {
            continue;
        }
        if let Some(ref sha) = current {
            map.entry(sha.clone()).or_default().push(CommitSubmoduleChange {
                path,
                pointed_sha: new_sha.to_string(),
            });
        }
    }

    Ok(map)
}

// ─── Worktrees ────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_worktree_list(cwd: String) -> Result<Vec<WorktreeEntry>, String> {
    let output = git_cmd()
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

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            if let Some(e) = current.take() {
                entries.push(e);
            }
            let path = line["worktree ".len()..].to_string();
            current = Some(WorktreeEntry {
                path,
                branch: String::new(),
                head: String::new(),
                is_main: false,
                is_locked: false,
                lock_reason: None,
                is_bare: false,
                is_prunable: false,
                prunable_reason: None,
            });
        } else if let Some(ref mut e) = current {
            if line == "main" {
                // Attribut explicite depuis git 2.36
                e.is_main = true;
            } else if line.starts_with("HEAD ") {
                e.head = line["HEAD ".len()..].to_string();
            } else if line.starts_with("branch ") {
                let full = &line["branch ".len()..];
                e.branch = full.strip_prefix("refs/heads/").unwrap_or(full).to_string();
            } else if line == "bare" {
                e.is_bare = true;
            } else if line.starts_with("locked") {
                e.is_locked = true;
                // Format : "locked" seul ou "locked <raison>" avec raison inline
                let reason = line["locked".len()..].trim();
                if !reason.is_empty() {
                    e.lock_reason = Some(reason.to_string());
                }
            } else if line.starts_with("prunable") {
                e.is_prunable = true;
                let reason = line["prunable".len()..].trim();
                if !reason.is_empty() {
                    e.prunable_reason = Some(reason.to_string());
                }
            } else if line == "detached" {
                e.branch = "(detached HEAD)".to_string();
            }
        }
    }
    if let Some(e) = current.take() {
        entries.push(e);
    }

    // Fallback pour git < 2.36 : l'attribut "main" n'existait pas.
    // Si aucune entrée n'est marquée is_main, on marque la première.
    if !entries.is_empty() && entries.iter().all(|e| !e.is_main) {
        entries[0].is_main = true;
    }

    Ok(entries)
}

#[tauri::command]
pub(crate) async fn git_worktree_add(
    cwd: String,
    path: String,
    branch: String,
    new_branch: Option<String>,
) -> Result<WorktreeEntry, String> {
    // Note, create folders if they dont exist.
    let target_path = std::path::Path::new(&path);
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create worktree base directory: {}", e))?;
        }
    }

    let mut cmd = git_cmd();
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

    // Récupérer le SHA HEAD réel depuis le nouveau worktree
    let head = git_cmd()
        .args(["rev-parse", "HEAD"])
        .current_dir(&path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    Ok(WorktreeEntry {
        path,
        branch: resolved_branch,
        head,
        is_main: false,
        is_locked: false,
        lock_reason: None,
        is_bare: false,
        is_prunable: false,
        prunable_reason: None,
    })
}

#[tauri::command]
pub(crate) async fn git_worktree_remove(cwd: String, path: String, force: Option<bool>) -> Result<(), String> {
    let mut cmd = git_cmd();
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

#[tauri::command]
pub(crate) async fn git_worktree_prune(cwd: String) -> Result<(), String> {
    let output = git_cmd()
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

#[tauri::command]
pub(crate) async fn git_worktree_status_all(cwd: String) -> Result<Vec<WorkspaceRepoStatus>, String> {
    let worktrees = git_worktree_list(cwd).await?;

    let statuses = worktrees.into_par_iter().map(|wt| {
        let path = wt.path.clone();
        let name = wt.branch.trim_start_matches("refs/heads/").to_string();

        let branch = git_cmd()
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        // Upstream : détecter si une remote est configurée, et extraire ahead/behind
        let upstream_out = git_cmd()
            .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
            .current_dir(&path)
            .output()
            .ok()
            .filter(|o| o.status.success());

        let has_upstream = upstream_out.is_some();
        let (ahead, behind) = upstream_out
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| {
                let parts: Vec<&str> = s.trim().split_whitespace().collect();
                if parts.len() == 2 {
                    Some((parts[0].parse::<u32>().unwrap_or(0), parts[1].parse::<u32>().unwrap_or(0)))
                } else { None }
            })
            .unwrap_or((0, 0));

        // Status : séparer les fichiers en conflit (UU/AA/DD/AU/UA/DU/UD) des simples modifiés
        let status_out = git_cmd()
            .args(["status", "--porcelain", "--untracked-files=no"])
            .current_dir(&path)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();

        const CONFLICT_CODES: &[&str] = &["UU", "AA", "DD", "AU", "UA", "DU", "UD"];
        let conflicted = status_out
            .lines()
            .filter(|l| l.len() >= 2 && CONFLICT_CODES.contains(&&l[..2]))
            .count() as u32;
        let modified = status_out
            .lines()
            .filter(|l| l.len() >= 2 && !CONFLICT_CODES.contains(&&l[..2]))
            .count() as u32;

        WorkspaceRepoStatus { path, name, branch, ahead, behind, has_upstream, modified, conflicted, error: None }
    }).collect();

    Ok(statuses)
}

#[tauri::command]
pub(crate) async fn git_worktree_repair(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut cmd = git_cmd();
    cmd.args(["worktree", "repair"]);
    for p in &paths {
        cmd.arg(p);
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to repair worktrees: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree repair failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

// ─── Git clone / fork ─────────────────────────────────────────

// ─── Clone progress helpers ──────────────────────────────────
//
// `git clone --progress` writes progress lines to stderr, mostly
// terminated by \r (carriage return) for in-place updates, not \n.
// We read stderr in raw chunks, split on both \r and \n, and emit a
// `clone-progress` Tauri event for each meaningful line so the
// CloneModal.vue can render a live progress bar.

/// One progress update emitted as a Tauri event.
#[derive(serde::Serialize, Clone)]
struct CloneProgress {
    stage:   String,   // "init" | "counting" | "compressing" | "receiving" | "resolving" | "done"
    percent: f32,      // 0 – 100
    message: String,   // raw trimmed line
}

fn extract_percent(line: &str) -> f32 {
    // "Receiving objects:  56% (456/812) ..."
    if let Some(pct_pos) = line.find('%') {
        let before = line[..pct_pos].trim_end();
        if let Some(start) = before.rfind(|c: char| c.is_whitespace()) {
            if let Ok(v) = before[start + 1..].parse::<f32>() {
                return v.clamp(0.0, 100.0);
            }
        }
    }
    0.0
}

fn parse_clone_progress(line: &str) -> Option<CloneProgress> {
    let l = line.trim();
    if l.is_empty() { return None; }
    if l.starts_with("Cloning into") {
        return Some(CloneProgress { stage: "init".into(),        percent: 0.0,                 message: l.to_string() });
    }
    if l.starts_with("remote: Counting") || l.starts_with("remote: Enumerating") {
        return Some(CloneProgress { stage: "counting".into(),    percent: extract_percent(l),   message: l.to_string() });
    }
    if l.starts_with("remote: Compressing") {
        return Some(CloneProgress { stage: "compressing".into(), percent: extract_percent(l),   message: l.to_string() });
    }
    if l.starts_with("Receiving objects:") {
        return Some(CloneProgress { stage: "receiving".into(),   percent: extract_percent(l),   message: l.to_string() });
    }
    if l.starts_with("Resolving deltas:") {
        return Some(CloneProgress { stage: "resolving".into(),   percent: extract_percent(l),   message: l.to_string() });
    }
    if l.contains("done") || l.contains("complete") {
        return Some(CloneProgress { stage: "done".into(),        percent: 100.0,                message: l.to_string() });
    }
    // Emit unknown lines too so the modal can show them
    Some(CloneProgress { stage: "info".into(), percent: 0.0, message: l.to_string() })
}

#[tauri::command]
pub(crate) async fn git_clone(url: String, dest: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    use std::io::Read;
    use tauri::Emitter;

    let url_trim = url.trim().to_string();
    let dest_trim = dest.trim().to_string();
    if url_trim.is_empty() { return Err("Empty URL".to_string()); }
    if dest_trim.is_empty() { return Err("Empty destination".to_string()); }

    let _t0 = Instant::now();

    // --progress forces git to emit progress even when stderr is not a tty.
    let mut child = git_cmd()
        .args(["clone", "--progress", &url_trim, &dest_trim])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn git clone: {}", e))?;

    // Stream stderr → parse progress lines → emit Tauri events.
    // Split on both \r and \n because git uses \r for in-place rewrites.
    let mut all_stderr: Vec<u8> = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = [0u8; 512];
        let mut carry = String::new();
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    all_stderr.extend_from_slice(&buf[..n]);
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let combined = carry.clone() + &chunk;
                    let parts: Vec<&str> = combined.split(|c| c == '\r' || c == '\n').collect();
                    let carry_idx = parts.len().saturating_sub(1);
                    carry = parts[carry_idx].to_string();
                    for part in &parts[..carry_idx] {
                        if let Some(prog) = parse_clone_progress(part) {
                            let _ = app_handle.emit("clone-progress", prog);
                        }
                    }
                }
            }
        }
        // Flush carry
        if let Some(prog) = parse_clone_progress(&carry) {
            let _ = app_handle.emit("clone-progress", prog);
        }
    }

    let status = child.wait().map_err(|e| format!("Failed to wait for git clone: {}", e))?;
    record_cmd(&format!("git clone {}", url_trim), &dest_trim, _t0.elapsed().as_millis() as u64, status.code().unwrap_or(-1));

    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&all_stderr).trim().to_string();
        return Err(if stderr_text.is_empty() { "git clone failed".to_string() } else { stderr_text });
    }

    // Emit final "done" event
    let _ = app_handle.emit("clone-progress", CloneProgress {
        stage: "done".into(), percent: 100.0, message: "Clone complete".to_string(),
    });

    Ok(dest_trim)
}

#[tauri::command]
pub(crate) async fn gh_fork(url: String, parent_dir: String) -> Result<String, String> {
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

    let output = hidden_cmd("gh")
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

// ─── Git hooks ─────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_hook_list(cwd: String) -> Result<Vec<HookEntry>, String> {
    if cwd.trim().is_empty() { return Err("cwd must not be empty".to_string()); }
    let repo = PathBuf::from(&cwd);
    let hooks_dir = repo.join(".git").join("hooks");

    if !hooks_dir.exists() {
        return Ok(Vec::new());
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut entries: Vec<HookEntry> = Vec::new();

    let read_dir = std::fs::read_dir(&hooks_dir)
        .map_err(|e| format!("Failed to read hooks directory: {}", e))?;

    for entry in read_dir.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();

        if fname.ends_with(".sample") {
            continue;
        }

        let (name, enabled) = if fname.ends_with(".disabled") {
            (fname[..fname.len() - ".disabled".len()].to_string(), false)
        } else {
            (fname.clone(), true)
        };

        if seen.contains(&name) {
            continue;
        }
        seen.insert(name.clone());

        let path = hooks_dir.join(&fname);

        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&path)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        };
        #[cfg(not(unix))]
        let executable = true;

        let preview = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();

        entries.push(HookEntry { name, enabled, executable, preview });
    }

    entries.sort_by(|a, b| {
        let ai = HOOK_NAMES.iter().position(|&n| n == a.name);
        let bi = HOOK_NAMES.iter().position(|&n| n == b.name);
        match (ai, bi) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.cmp(&b.name),
        }
    });

    Ok(entries)
}

#[tauri::command]
pub(crate) async fn git_hook_toggle(cwd: String, name: String, enabled: bool) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains('.') {
        return Err(format!("Invalid hook name: {}", name));
    }
    if cwd.trim().is_empty() { return Err("cwd must not be empty".to_string()); }
    let repo = PathBuf::from(&cwd);
    let hooks_dir = repo.join(".git").join("hooks");

    let enabled_path = hooks_dir.join(&name);
    let disabled_path = hooks_dir.join(format!("{}.disabled", name));

    if enabled {
        if disabled_path.exists() {
            std::fs::rename(&disabled_path, &enabled_path)
                .map_err(|e| format!("Failed to enable hook: {}", e))?;
        }
    } else {
        if enabled_path.exists() {
            std::fs::rename(&enabled_path, &disabled_path)
                .map_err(|e| format!("Failed to disable hook: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_hook_create(cwd: String, name: String, content: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains('.') {
        return Err(format!("Invalid hook name: {}", name));
    }
    if cwd.trim().is_empty() { return Err("cwd must not be empty".to_string()); }
    let repo = PathBuf::from(&cwd);
    let hooks_dir = repo.join(".git").join("hooks");

    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("Failed to create hooks directory: {}", e))?;

    let hook_path = hooks_dir.join(&name);

    let script = if content.starts_with("#!") {
        content.clone()
    } else {
        format!("#!/usr/bin/env bash\n{}", content)
    };

    std::fs::write(&hook_path, script)
        .map_err(|e| format!("Failed to write hook: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&hook_path)
            .map_err(|e| format!("Failed to read hook metadata: {}", e))?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(&hook_path, perms)
            .map_err(|e| format!("Failed to set hook permissions: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn git_hook_delete(cwd: String, name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains('.') {
        return Err(format!("Invalid hook name: {}", name));
    }
    if cwd.trim().is_empty() { return Err("cwd must not be empty".to_string()); }
    let repo = PathBuf::from(&cwd);
    let hooks_dir = repo.join(".git").join("hooks");

    let enabled_path = hooks_dir.join(&name);
    let disabled_path = hooks_dir.join(format!("{}.disabled", name));

    if enabled_path.exists() {
        std::fs::remove_file(&enabled_path)
            .map_err(|e| format!("Failed to delete hook: {}", e))?;
    }
    if disabled_path.exists() {
        let _ = std::fs::remove_file(&disabled_path);
    }

    Ok(())
}

// ─── Agent sessions ───────────────────────────────────────────

fn active_cwds_for_tool(tool_name: &str) -> HashSet<String> {
    let mut cwds = HashSet::new();

    // ── lsof approach ───────────────────────────────────────
    let lsof = std::process::Command::new("lsof")
        .args(["-a", "-d", "cwd", "-c", tool_name, "-F", "n"])
        .output();
    if let Ok(out) = lsof {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if let Some(path) = line.strip_prefix('n') {
                    cwds.insert(path.to_string());
                }
            }
            return cwds; // lsof succeeded — done
        }
    }

    // ── Linux /proc fallback ─────────────────────────────────
    #[cfg(target_os = "linux")]
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let pid_path = entry.path();
            if !entry.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let exe_path = pid_path.join("exe");
            if let Ok(exe) = std::fs::read_link(&exe_path) {
                let basename = exe.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if !basename.to_lowercase().starts_with(&tool_name.to_lowercase()) {
                    continue;
                }
            } else {
                continue;
            }
            if let Ok(cwd) = std::fs::read_link(pid_path.join("cwd")) {
                if let Some(s) = cwd.to_str() {
                    cwds.insert(s.to_string());
                }
            }
        }
    }

    cwds
}

fn detect_agent_tool(worktree_path: &str) -> Option<String> {
    let base = std::path::Path::new(worktree_path);
    if base.join(".claude").is_dir() {
        return Some("claude".to_string());
    }
    if base.join(".cursor").is_dir() {
        return Some("cursor".to_string());
    }
    if base.join(".windsurf").is_dir() {
        return Some("windsurf".to_string());
    }
    if base.join(".mcp.json").exists() {
        return Some("other".to_string());
    }
    None
}

#[tauri::command]
pub(crate) async fn agent_session_list(cwd: String) -> Result<Vec<AgentSession>, String> {
    if cwd.trim().is_empty() { return Err("cwd must not be empty".to_string()); }
    let path = PathBuf::from(&cwd);
    let worktrees = git_worktree_list(path.to_string_lossy().to_string()).await?;

    let mut cwds_cache: HashMap<String, HashSet<String>> = HashMap::new();

    let sessions: Vec<AgentSession> = worktrees
        .into_iter()
        .filter_map(|wt| {
            let tool = detect_agent_tool(&wt.path)?;

            let active_cwds = cwds_cache
                .entry(tool.clone())
                .or_insert_with(|| active_cwds_for_tool(&tool));
            let active = active_cwds.contains(&wt.path);

            let branch = git_cmd()
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(&wt.path)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| wt.branch.trim_start_matches("refs/heads/").to_string());

            let (ahead, behind) = git_cmd()
                .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
                .current_dir(&wt.path)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .and_then(|s| {
                    let v: Vec<&str> = s.trim().split_whitespace().collect();
                    if v.len() == 2 {
                        Some((v[0].parse::<u32>().unwrap_or(0), v[1].parse::<u32>().unwrap_or(0)))
                    } else {
                        None
                    }
                })
                .unwrap_or((0, 0));

            let modified = git_cmd()
                .args(["status", "--porcelain", "--untracked-files=no"])
                .current_dir(&wt.path)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.lines().filter(|l| !l.is_empty()).count() as u32)
                .unwrap_or(0);

            Some(AgentSession { path: wt.path, branch, tool, active, ahead, behind, modified })
        })
        .collect();

    Ok(sessions)
}

#[tauri::command]
pub(crate) async fn agent_session_launch(cwd: String, tool: String) -> Result<(), String> {
    if cwd.trim().is_empty() { return Err("cwd must not be empty".to_string()); }
    let path = PathBuf::from(&cwd);
    let binary = match tool.as_str() {
        "cursor"   => "cursor",
        "windsurf" => "windsurf",
        _          => "claude",
    };

    hidden_cmd(binary)
        .current_dir(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {}", binary, e))?;

    Ok(())
}

// ─── Shortlog ────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_shortlog(cwd: String) -> Result<Vec<ShortlogEntry>, String> {
    let output = git_cmd()
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
    entries.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(entries)
}

/// Top author (most commits) on each branch — counting only the commits that
/// are unique to the branch, i.e. the `<base>..<branch>` range where `<base>`
/// is the repo's main branch. This is the person who did most of the work *on
/// that branch*, not the most prolific author across its whole history.
///
/// For the base branch itself (or any branch with no commits ahead of base)
/// the range is empty, so we fall back to the branch's full history.
///
/// Branches are processed in parallel (rayon) since each is an independent
/// `git` spawn — invoked on-demand when the branch picker opens, not on a hot
/// path, but the fan-out keeps it snappy on repos with many branches. Branches
/// with no resolvable author are omitted.
#[tauri::command]
pub(crate) async fn git_branch_top_authors(
    cwd: String,
    branches: Vec<String>,
) -> Result<Vec<BranchTopAuthor>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = get_main_branch_name(&cwd);
        let results: Vec<BranchTopAuthor> = branches
            .into_par_iter()
            .filter_map(|branch| {
                // Commits unique to this branch first; fall back to the branch's
                // full history when that range is empty (the base branch itself,
                // or a branch with nothing ahead of base).
                let range = format!("{}..{}", base, branch);
                let top = shortlog_top(&cwd, &range)
                    .or_else(|| shortlog_top(&cwd, &branch))?;
                Some(BranchTopAuthor {
                    branch,
                    name: top.name,
                    email: top.email,
                    count: top.count,
                })
            })
            .collect();
        Ok(results)
    })
    .await
    .map_err(|e| format!("git_branch_top_authors join error: {}", e))?
}

/// Author with the most commits in a `git shortlog -sne <revspec>`, or None if
/// the spec resolves to no commits / fails.
fn shortlog_top(cwd: &str, revspec: &str) -> Option<ShortlogEntry> {
    let output = git_cmd()
        .args(["shortlog", "-sne", revspec])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_shortlog_line)
        .max_by_key(|e| e.count)
}

// ─── Git exec / autocomplete ─────────────────────────────────

// Async + spawn_blocking: a synchronous Tauri command runs on the webview main
// thread, so a slow `git` invocation (e.g. `status` on a large repo, ~1.3s)
// freezes the UI. Offloading the blocking process spawn keeps the UI responsive.
#[tauri::command]
pub(crate) async fn git_exec(cwd: String, args: Vec<String>) -> Result<TerminalResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if args.is_empty() {
            return Err("No arguments provided".to_string());
        }

        let output = git_cmd()
            .args(&args)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to execute git command: {}", e))?;

        Ok(TerminalResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn git_autocomplete(cwd: String, partial: String) -> Result<Vec<String>, String> {
    let mut suggestions = Vec::new();

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
        let parts: Vec<&str> = partial.splitn(2, ' ').collect();
        let arg_prefix = if parts.len() > 1 {
            parts[1].split_whitespace().last().unwrap_or("")
        } else {
            ""
        };

        let output = git_cmd()
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

// ─── Git config ────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn set_git_config(git_path: String) -> Result<(), String> {
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

// ─── Conflicted files ──────────────────────────────────────

#[tauri::command]
pub(crate) async fn get_conflicted_files(cwd: String) -> Result<Vec<String>, String> {
    let output = git_cmd()
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

// ─── Tree conflicts (markerless: modify/delete, both-deleted) ─────

/// Parse `git status --porcelain=v2` and return unmerged paths that are *tree*
/// conflicts (not pure content conflicts). A porcelain-v2 unmerged line looks like:
///   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
/// where m1/m2/m3 are the octal modes for stages 1/2/3 ("000000" when the stage
/// is absent) and mW is the worktree mode. We treat a path as a tree conflict
/// when NOT (stage2 && stage3), i.e. at least one of ours/theirs is missing —
/// modify/delete, both-deleted, add/delete. Pure content conflicts (UU, AA)
/// have both stages and carry `<<<<<<<` markers, so the existing content flow
/// handles them.
fn collect_tree_conflicts(cwd: &str) -> Result<Vec<crate::types::TreeConflict>, String> {
    let output = git_cmd()
        // `-z` => NUL-terminated records with verbatim (un-C-quoted) paths, so a
        // path containing a quote, newline or non-ASCII byte parses correctly.
        .args(["status", "--porcelain=v2", "-z", "--untracked-files=no"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();
    for record in stdout.split('\0') {
        // Unmerged entries start with "u ".
        let Some(rest) = record.strip_prefix("u ") else { continue };
        // Porcelain-v2 unmerged format (10 space-separated tokens):
        //   XY sub m1 m2 m3 mW h1 h2 h3 path
        // splitn(10, ' ') puts path at index 9.
        let mut parts = rest.splitn(10, ' ');
        let code = parts.next().unwrap_or("").to_string();   // XY
        let _sub = parts.next();                              // submodule state
        let m1 = parts.next().unwrap_or("000000");           // stage 1 (base)
        let m2 = parts.next().unwrap_or("000000");           // stage 2 (ours)
        let m3 = parts.next().unwrap_or("000000");           // stage 3 (theirs)
        let _mw = parts.next();                               // worktree mode
        let _h1 = parts.next();
        let _h2 = parts.next();
        let _h3 = parts.next();
        let path = parts.next().unwrap_or("").to_string();   // remainder = path
        if path.is_empty() { continue; }
        let has_base = m1 != "000000";
        let has_ours = m2 != "000000";
        let has_theirs = m3 != "000000";
        // Only markerless tree conflicts: at least one side missing.
        if has_ours && has_theirs { continue; }
        result.push(crate::types::TreeConflict { path, code, has_base, has_ours, has_theirs });
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn get_tree_conflicts(cwd: String) -> Result<Vec<crate::types::TreeConflict>, String> {
    collect_tree_conflicts(&cwd)
}

// ─── Tree conflict resolution ────────────────────────────────

/// Run a git command (args array, no shell interpolation) in `cwd`, mapping failure to a message.
fn run_git_checked(cwd: &str, args: &[&str], what: &str) -> Result<(), String> {
    let output = git_cmd()
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git {}: {}", what, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed: {}", what, stderr.trim()));
    }
    Ok(())
}

/// Synchronous implementation — tested directly to avoid async test runtimes.
fn apply_tree_resolution(cwd: &str, path: &str, choice: &str) -> Result<(), String> {
    // Guard against path traversal; we still pass the *relative* path to git.
    let _ = safe_repo_path(cwd, path)?;
    match choice {
        "ours" => {
            run_git_checked(cwd, &["checkout", "--ours", "--", path], "checkout --ours")?;
            run_git_checked(cwd, &["add", "--", path], "add")?;
        }
        "theirs" => {
            run_git_checked(cwd, &["checkout", "--theirs", "--", path], "checkout --theirs")?;
            run_git_checked(cwd, &["add", "--", path], "add")?;
        }
        "delete" => {
            run_git_checked(cwd, &["rm", "-f", "--", path], "rm")?;
        }
        other => return Err(format!("unknown choice: {}", other)),
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn resolve_tree_conflict(cwd: String, path: String, choice: String) -> Result<(), String> {
    apply_tree_resolution(&cwd, &path, &choice)
}

// ─── Reconstruct content conflict from index stages ──────────

use crate::types::ReconstructedConflict;

/// Read the blob bytes for a given index stage of `path`, or empty if the stage is absent.
fn read_stage_blob(cwd: &str, stage: u8, path: &str) -> Vec<u8> {
    let spec = format!(":{}:{}", stage, path);
    match git_cmd().args(["show", &spec]).current_dir(cwd).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => Vec::new(),
    }
}

/// Reconstruct a content conflict from the index stages. Sync so it is unit-testable
/// without an async runtime; the #[tauri::command] is a thin wrapper.
fn reconstruct_conflict_impl(cwd: &str, path: &str) -> Result<ReconstructedConflict, String> {
    let _ = safe_repo_path(cwd, path)?; // traversal guard

    let base = read_stage_blob(cwd, 1, path);   // may be empty (add/add)
    let ours = read_stage_blob(cwd, 2, path);
    let theirs = read_stage_blob(cwd, 3, path);
    if ours.is_empty() && theirs.is_empty() {
        return Err(format!("no index stages for {}", path));
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gitwand-recon-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {}", e))?;

    let write_tmp = |name: &str, data: &[u8]| -> Result<std::path::PathBuf, String> {
        let p = dir.join(name);
        std::fs::File::create(&p)
            .and_then(|mut f| { use std::io::Write; f.write_all(data) })
            .map_err(|e| format!("write {}: {}", name, e))?;
        Ok(p)
    };

    let result = (|| -> Result<String, String> {
        let ours_p = write_tmp("ours", &ours)?;
        let base_p = write_tmp("base", &base)?;
        let theirs_p = write_tmp("theirs", &theirs)?;
        let out = git_cmd()
            .args([
                "merge-file", "-p", "--diff3",
                "-L", "ours", "-L", "base", "-L", "theirs",
                ours_p.to_str().ok_or("bad temp path")?,
                base_p.to_str().ok_or("bad temp path")?,
                theirs_p.to_str().ok_or("bad temp path")?,
            ])
            .current_dir(cwd)
            .output()
            .map_err(|e| format!("git merge-file: {}", e))?;
        // exit 255 = real error; 0/N = clean/conflicts (stdout is the merged content either way)
        if out.status.code() == Some(255) {
            return Err(format!("git merge-file error: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })();

    let _ = std::fs::remove_dir_all(&dir); // always clean up
    let content = result?;

    let wt = std::fs::read(safe_repo_path(cwd, path)?).unwrap_or_default();
    let wt_matches_side = (!ours.is_empty() && wt == ours) || (!theirs.is_empty() && wt == theirs);

    Ok(ReconstructedConflict { content, wt_matches_side })
}

#[tauri::command]
pub(crate) async fn reconstruct_conflict(cwd: String, path: String) -> Result<ReconstructedConflict, String> {
    reconstruct_conflict_impl(&cwd, &path)
}

// ─── Git remote info ─────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_remote_info(cwd: String) -> Result<RemoteInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = git_cmd()
            .args(["remote", "-v"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to get remote info: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        // Prefer `origin` (the canonical remote) over whatever sorts first.
        // `git remote -v` lists remotes alphabetically, so a `fork` remote
        // would otherwise shadow `origin` and make every origin-targeted
        // operation (unpushed-tag detection, PR lookups, connectivity probe…)
        // point at the wrong repository.
        let mut first: Option<(String, String)> = None;
        let mut origin: Option<(String, String)> = None;
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
            if name == "origin" {
                origin = Some((name, url));
                break;
            }
            if first.is_none() {
                first = Some((name, url));
            }
        }

        if let Some((name, url)) = origin.or(first) {
            let provider = if url.contains("github.com") {
                "github"
            } else if url.contains("gitlab.com") || url.contains("gitlab") {
                "gitlab"
            } else if url.contains("bitbucket.org") || url.contains("bitbucket") {
                "bitbucket"
            } else if url.contains("dev.azure.com") || url.contains("visualstudio.com") {
                "azure"
            } else {
                "unknown"
            };

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
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Git user ────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_get_user(cwd: String) -> Result<serde_json::Value, String> {
    let name_out = git_cmd()
        .args(["config", "user.name"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git config: {}", e))?;
    let email_out = git_cmd()
        .args(["config", "user.email"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git config: {}", e))?;
    let name = String::from_utf8_lossy(&name_out.stdout).trim().to_string();
    let email = String::from_utf8_lossy(&email_out.stdout).trim().to_string();
    Ok(serde_json::json!({ "name": name, "email": email }))
}

// ─── Monorepo detection ──────────────────────────────────────

/// Detect monorepo workspaces.
///
/// Precedence: pnpm > Cargo > go.work > nx > turbo > npm/yarn
#[tauri::command]
pub(crate) async fn detect_monorepo(cwd: String) -> Result<MonorepoInfo, String> {
    let cwd_path = std::path::Path::new(&cwd);

    // ── 1. pnpm ──────────────────────────────────────────────────────────
    let pnpm_ws = cwd_path.join("pnpm-workspace.yaml");
    if pnpm_ws.exists() {
        let content = std::fs::read_to_string(&pnpm_ws)
            .unwrap_or_default();
        let packages = find_workspace_packages(&cwd, &content, "pnpm");
        return Ok(MonorepoInfo {
            is_monorepo: true,
            manager: "pnpm".to_string(),
            packages,
        });
    }

    // ── 2. Cargo workspace ───────────────────────────────────────────────
    let cargo_toml = cwd_path.join("Cargo.toml");
    if cargo_toml.exists() {
        let content = std::fs::read_to_string(&cargo_toml).unwrap_or_default();
        if content.contains("[workspace]") {
            let packages = find_workspace_packages(&cwd, &content, "cargo");
            return Ok(MonorepoInfo {
                is_monorepo: true,
                manager: "cargo".to_string(),
                packages,
            });
        }
    }

    // ── 3. go.work ───────────────────────────────────────────────────────
    let go_work = cwd_path.join("go.work");
    if go_work.exists() {
        let content = std::fs::read_to_string(&go_work).unwrap_or_default();
        let packages = find_workspace_packages(&cwd, &content, "go");
        return Ok(MonorepoInfo {
            is_monorepo: true,
            manager: "go".to_string(),
            packages,
        });
    }

    // ── 4. nx ────────────────────────────────────────────────────────────
    let nx_json = cwd_path.join("nx.json");
    if nx_json.exists() {
        let content = std::fs::read_to_string(&nx_json).unwrap_or_default();
        let packages = find_workspace_packages(&cwd, &content, "nx");
        return Ok(MonorepoInfo {
            is_monorepo: true,
            manager: "nx".to_string(),
            packages,
        });
    }

    // ── 5. turbo ─────────────────────────────────────────────────────────
    let turbo_json = cwd_path.join("turbo.json");
    if turbo_json.exists() {
        // turbo defers workspace layout to package.json
        let pkg_json = cwd_path.join("package.json");
        let pkg_content = if pkg_json.exists() {
            std::fs::read_to_string(&pkg_json).unwrap_or_default()
        } else {
            String::new()
        };
        let packages = find_workspace_packages(&cwd, &pkg_content, "turbo");
        return Ok(MonorepoInfo {
            is_monorepo: true,
            manager: "turbo".to_string(),
            packages,
        });
    }

    // ── 6. npm / yarn (package.json workspaces) ──────────────────────────
    let pkg_json = cwd_path.join("package.json");
    if pkg_json.exists() {
        let content = std::fs::read_to_string(&pkg_json).unwrap_or_default();
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

// ─── Read .gitwandrc ─────────────────────────────────────────

#[tauri::command]
pub(crate) async fn read_gitwandrc(cwd: String) -> String {
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

// ─── Shell exec ──────────────────────────────────────────────

/// Run an arbitrary shell command in `cwd` and return combined stdout+stderr.
///
/// Security: the command string is NOT constructed from user-repo content —
/// it is authored explicitly by the user in the Settings UI and stored in
/// localStorage. It runs through `/bin/sh -c`, so the user has full shell
/// access, which is intentional (same model as git hooks).
#[tauri::command]
pub(crate) async fn shell_exec(cwd: String, command: String) -> Result<String, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let output = hidden_cmd("/bin/sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout, stderr)
    };

    if output.status.success() {
        Ok(combined)
    } else {
        let code = output.status.code().unwrap_or(-1);
        Err(format!("Exit {}: {}", code, combined.trim()))
    }
}

// ─── GitHub CLI ──────────────────────────────────────────────

/// Returns the GitHub login of the currently authenticated `gh` user.
/// Calls `gh api user --jq .login` — fast, no repo context needed.
#[tauri::command]
pub(crate) async fn gh_current_user() -> Result<String, String> {
    // Settings-managed token present → resolve via REST (no `gh` needed).
    if let Some(tok) = crate::commands::github_api::settings_github_token() {
        return crate::commands::github_api::rest_current_user(&tok);
    }
    // GH_TOKEN propagation: centralized in `hidden_cmd` (cf. git/cmd.rs).
    let output = hidden_cmd("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| format!("Failed to run gh: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api user failed: {}", stderr.trim()));
    }
    let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if login.is_empty() {
        return Err("gh returned empty login — run `gh auth login`".to_string());
    }
    Ok(login)
}

/// Returns the list of file paths changed by a given PR number.
/// Calls `gh pr view <number> --json files --jq '[.files[].path]'`.
//
// Naming note: `pr_files` lacks the `gh_` prefix used by sibling commands
// (gh_list_prs, gh_create_pr, etc.) for historical reasons. The TS wrapper
// `ghPrFiles` re-introduces the prefix for consistency on the consumer side.
// Renaming the Tauri command would be a breaking change for any external
// caller (e.g. parity probes); not worth it. Documented here so future
// readers don't think it's missing the prefix by accident.
#[tauri::command]
pub(crate) async fn pr_files(cwd: String, number: i64) -> Result<Vec<String>, String> {
    if let Some(tok) = crate::commands::github_api::settings_github_token() {
        return crate::commands::github_api::rest_pr_files(&cwd, number, &tok);
    }
    let output = hidden_cmd("gh")
        .args([
            "pr", "view", &number.to_string(),
            "--json", "files",
            "--jq", "[.files[].path]",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let json = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<String>>(json.trim())
        .map_err(|e| e.to_string())
}

// ─── Fork Point (v2.11) ──────────────────────────────────────
//
// `git merge-base ref1 ref2` returns the best common ancestor of two refs.
// Used by CommitGraph.vue to determine which commits are "before the fork
// point" (shared history) and dim them visually, making the branch's unique
// commits stand out.
//
// Returns the full SHA of the merge-base commit, or "" when there is no
// common ancestor (unrelated histories, empty repo).

#[tauri::command]
pub(crate) async fn git_merge_base(cwd: String, ref1: String, ref2: String) -> Result<String, String> {
    let output = git_cmd()
        .args(["merge-base", &ref1, &ref2])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git merge-base failed: {}", e))?;
    if !output.status.success() {
        // Exit code 1 means no common ancestor — not an error worth surfacing.
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ─── Open a URL in the system browser ────────────────────────
//
// The webview's `window.open` is a no-op in Tauri, so external links must be
// handed to the OS default handler. Restricted to http(s) to avoid opening
// arbitrary schemes (file://, etc.).

#[tauri::command]
pub(crate) async fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Refusing to open non-http(s) URL".to_string());
    }
    // Reject whitespace and control characters. A real URL percent-encodes
    // these; their presence signals a malformed or hostile value. Notably this
    // blocks any newline that could be reinterpreted by a handler.
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Refusing to open URL with whitespace or control characters".to_string());
    }

    // macOS/Windows fire-and-forget on purpose: `open`/`explorer` are single,
    // always-present launchers with no fallback chain to try, and neither
    // platform has the AppImage env pollution that made the Linux opener (and
    // its delegated helper) die silently — so the exit-status handling below is
    // Linux-only by design, not an oversight.
    #[cfg(target_os = "macos")]
    {
        hidden_cmd("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
        Ok(())
    }

    // Windows: invoke `explorer.exe <url>` directly rather than `cmd /C start`.
    // `cmd.exe` re-parses its command line and treats `& | ^ < >` as shell
    // metacharacters, so a link like `https://x/&calc` (legitimate query
    // strings use `&`) would split into a second command and execute it.
    // `explorer.exe` is not a shell — it receives the URL as a single argv
    // entry via the standard CommandLineToArgvW rules, with no `&` splitting.
    #[cfg(target_os = "windows")]
    {
        hidden_cmd("explorer")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
        Ok(())
    }

    // Linux: a single fire-and-forget `xdg-open` swallowed every failure — in
    // the released AppImage the spawned opener (and the Qt/KDE or GTK helper it
    // delegates to) inherited `AppRun`'s `LD_LIBRARY_PATH`/`QT_PLUGIN_PATH`
    // pollution, loaded ABI-incompatible bundled libs, and died before any
    // browser appeared, with no error surfaced (issue #48 family). We now:
    //   1. spawn through `hidden_cmd`, which de-pollutes the child env inside an
    //      AppImage (see `git::cmd::appimage_env_fixes`);
    //   2. try a chain of openers so one broken handler can't sink the click;
    //   3. inspect the exit status instead of ignoring it, so a real failure
    //      becomes a loud error rather than a silent no-op.
    #[cfg(target_os = "linux")]
    {
        // (binary, prefix-args). `xdg-open` first to honour the user's default;
        // `gio open` (GTK/portal — matches our bundled stack) and `kde-open5`
        // as fallbacks for the common desktops.
        let openers: [(&str, &[&str]); 3] =
            [("xdg-open", &[]), ("gio", &["open"]), ("kde-open5", &[])];
        let mut errors: Vec<String> = Vec::new();
        for (bin, prefix) in openers {
            let mut cmd = hidden_cmd(bin);
            cmd.args(prefix).arg(&url);
            // De-pollute PATH/XDG_* so the opener resolves the *system*
            // binary and mime/browser association, not the AppImage's bundled
            // ones — the silent no-open in issue #52.
            sanitize_appimage_search_paths(&mut cmd);
            match try_open_linux(cmd, bin) {
                Ok(()) => return Ok(()),
                Err(e) => errors.push(e),
            }
        }
        // Last resort: an explicit `$BROWSER`.
        if let Ok(browser) = std::env::var("BROWSER") {
            let browser = browser.trim().to_string();
            if !browser.is_empty() {
                let mut cmd = hidden_cmd(&browser);
                cmd.arg(&url);
                sanitize_appimage_search_paths(&mut cmd);
                match try_open_linux(cmd, "$BROWSER") {
                    Ok(()) => return Ok(()),
                    Err(e) => errors.push(e),
                }
            }
        }
        Err(format!(
            "Failed to open URL via system openers: {}",
            errors.join("; ")
        ))
    }
}

/// Spawn an opener and decide success without hanging the caller.
///
/// System openers (`xdg-open`, `gio open`, `kde-open5`) hand the URL to the
/// desktop and exit promptly — a non-zero exit means the open genuinely failed
/// (e.g. a Qt helper crashing on AppImage lib pollution), which we surface.
/// A graphical browser launched directly via `$BROWSER` may instead stay in the
/// foreground; if the child is still alive after a short grace period we treat
/// that as a successful hand-off rather than blocking on it.
#[cfg(target_os = "linux")]
fn try_open_linux(mut cmd: std::process::Command, label: &str) -> Result<(), String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Duration;
    let start = Instant::now();
    // Capture stderr so a downstream failure (e.g. a Qt/GTK helper crashing on
    // AppImage lib mismatch) is surfaced instead of swallowed; record each
    // attempt's exit code in the command log (⌘⇧L) so a silent no-open in the
    // released build is still diagnosable. See issue #52.
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: failed to spawn: {}", label, e))?;
    let log = |code: i32| {
        record_cmd(
            &format!("open_url[{}]", label),
            "",
            start.elapsed().as_millis() as u64,
            code,
        );
    };
    let deadline = start + Duration::from_millis(400);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                log(code);
                if status.success() {
                    return Ok(());
                }
                let mut stderr = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut stderr);
                }
                let stderr = stderr.trim();
                return Err(if stderr.is_empty() {
                    format!("{}: exited with status {}", label, code)
                } else {
                    format!("{}: exited with status {} ({})", label, code, stderr)
                });
            }
            // Still alive after the grace period: a foreground browser launched
            // directly. Treat as a successful hand-off, but drain its stderr in a
            // detached thread so a chatty child can't block on a full pipe buffer.
            Ok(None) if Instant::now() >= deadline => {
                log(0);
                if let Some(mut e) = child.stderr.take() {
                    // O(1) memory: discard as it arrives. A foreground browser
                    // can run for hours and log megabytes — never buffer it.
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut e, &mut std::io::sink());
                    });
                }
                return Ok(());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("{}: wait failed: {}", label, e)),
        }
    }
}

// ─── Open in external editor ─────────────────────────────────

#[tauri::command]
pub(crate) async fn open_in_editor(cwd: String, path: String, editor: String) -> Result<(), String> {
    let editor_cmd = if editor.trim().is_empty() {
        "code".to_string()
    } else {
        editor.trim().to_string()
    };
    let full_path = std::path::Path::new(&cwd).join(&path);
    hidden_cmd(&editor_cmd)
        .arg(&full_path)
        .spawn()
        .map_err(|e| format!("Failed to open editor '{}': {}", editor_cmd, e))?;
    Ok(())
}

// ─── Transparent command log ──────────────────────────────────

#[tauri::command]
pub(crate) async fn get_command_log() -> Vec<crate::git::cmd::CmdLogEntry> {
    crate::git::cmd::cmd_log_snapshot()
}

#[cfg(all(test, target_os = "linux"))]
mod open_url_tests {
    use super::try_open_linux;
    use std::process::Command;

    #[test]
    fn opener_exiting_zero_is_success() {
        assert!(try_open_linux(Command::new("true"), "true").is_ok());
    }

    #[test]
    fn opener_exiting_nonzero_is_error() {
        let err = try_open_linux(Command::new("false"), "false").unwrap_err();
        assert!(err.contains("false"), "error should name the opener: {err}");
        assert!(err.contains("status"), "error should report the exit: {err}");
    }

    #[test]
    fn missing_opener_is_error() {
        let err = try_open_linux(
            Command::new("gitwand-no-such-opener-binary"),
            "ghost",
        )
        .unwrap_err();
        assert!(err.contains("ghost"), "error should name the opener: {err}");
    }

    #[test]
    fn long_running_opener_is_treated_as_handed_off() {
        // A handler still alive after the grace window (like a foreground
        // browser) must not hang the caller — it counts as a successful open.
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        assert!(try_open_linux(cmd, "sleep").is_ok());
    }
}

#[cfg(test)]
mod tree_conflict_tests {
    use super::*;
    use crate::git::cmd::git_binary;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempRepo { path: PathBuf }
    impl Drop for TempRepo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.path); } }
    impl TempRepo {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("gitwand-tree-test-{}-{}-{}", pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }
        fn cwd(&self) -> String { self.path.to_str().unwrap().to_string() }
        fn git(&self, args: &[&str]) -> std::process::Output {
            let out = Command::new(git_binary()).args(args).current_dir(&self.path).output()
                .unwrap_or_else(|e| panic!("git {:?} spawn: {}", args, e));
            out
        }
        fn git_ok(&self, args: &[&str]) {
            let out = self.git(args);
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).unwrap(); }
            std::fs::write(p, content).unwrap();
        }
        fn commit_all(&self, msg: &str) { self.git_ok(&["add", "-A"]); self.git_ok(&["commit", "-q", "-m", msg]); }
    }

    /// Build a modify/delete conflict: main deletes the file, feature modifies it,
    /// then merge main into feature → "UD" (modified by us / deleted by them).
    fn make_modify_delete(repo: &TempRepo) {
        repo.write("doomed.txt", "original\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("doomed.txt", "MODIFIED by feature\n");
        repo.commit_all("feature modifies");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.git_ok(&["rm", "-q", "doomed.txt"]);
        repo.commit_all("main deletes");
        repo.git_ok(&["checkout", "-q", "feature"]);
        // Merge main into feature — conflicts, returns non-zero; ignore status.
        let _ = repo.git(&["merge", "--no-edit", "main"]);
    }

    #[test]
    fn detects_modify_delete_as_tree_conflict() {
        let repo = TempRepo::new();
        make_modify_delete(&repo);
        let conflicts = collect_tree_conflicts(&repo.cwd()).expect("collect_tree_conflicts failed");
        let tc = conflicts.iter().find(|c| c.path == "doomed.txt").expect("doomed.txt is a tree conflict");
        assert!(tc.has_ours, "feature (ours) modified it → stage 2 present");
        assert!(!tc.has_theirs, "main (theirs) deleted it → stage 3 absent");
        assert_eq!(tc.code, "UD");
    }

    #[test]
    fn detects_modify_delete_with_spaced_path() {
        // Locks in the `-z` parsing: a path containing a space must still be
        // captured whole (porcelain v2 only C-quotes paths in non-`-z` mode).
        let repo = TempRepo::new();
        repo.write("my doomed file.txt", "original\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("my doomed file.txt", "MODIFIED by feature\n");
        repo.commit_all("feature modifies");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.git_ok(&["rm", "-q", "my doomed file.txt"]);
        repo.commit_all("main deletes");
        repo.git_ok(&["checkout", "-q", "feature"]);
        let _ = repo.git(&["merge", "--no-edit", "main"]);
        let conflicts = collect_tree_conflicts(&repo.cwd()).expect("collect_tree_conflicts failed");
        let tc = conflicts
            .iter()
            .find(|c| c.path == "my doomed file.txt")
            .expect("spaced path is captured verbatim");
        assert!(tc.has_ours && !tc.has_theirs);
    }

    #[test]
    fn resolve_keep_ours_stages_modified_version() {
        let repo = TempRepo::new();
        make_modify_delete(&repo); // feature(ours) modified doomed.txt, main(theirs) deleted it
        apply_tree_resolution(&repo.cwd(), "doomed.txt", "ours").unwrap();
        // No longer unmerged:
        assert!(collect_tree_conflicts(&repo.cwd()).unwrap().iter().all(|c| c.path != "doomed.txt"));
        // Working tree keeps the modified version:
        assert_eq!(std::fs::read_to_string(repo.path.join("doomed.txt")).unwrap(), "MODIFIED by feature\n");
    }

    #[test]
    fn resolve_delete_removes_the_file() {
        let repo = TempRepo::new();
        make_modify_delete(&repo);
        apply_tree_resolution(&repo.cwd(), "doomed.txt", "delete").unwrap();
        assert!(collect_tree_conflicts(&repo.cwd()).unwrap().iter().all(|c| c.path != "doomed.txt"));
        assert!(!repo.path.join("doomed.txt").exists(), "file removed from working tree");
    }

    #[test]
    fn resolve_rejects_unknown_choice() {
        let repo = TempRepo::new();
        make_modify_delete(&repo);
        let err = apply_tree_resolution(&repo.cwd(), "doomed.txt", "bogus");
        assert!(err.is_err(), "unknown choice must error");
    }

    #[test]
    fn excludes_pure_content_conflict() {
        let repo = TempRepo::new();
        repo.write("shared.txt", "a\nb\nc\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "a\nFEATURE\nc\n");
        repo.commit_all("feature");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "a\nMAIN\nc\n");
        repo.commit_all("main");
        repo.git_ok(&["checkout", "-q", "feature"]);
        let _ = repo.git(&["merge", "--no-edit", "main"]);
        let conflicts = collect_tree_conflicts(&repo.cwd()).expect("collect_tree_conflicts failed");
        assert!(conflicts.iter().all(|c| c.path != "shared.txt"), "content conflict (UU) must NOT be reported as a tree conflict");
    }

    /// Build a UU content conflict on `shared.txt`, leaving markers in the working tree.
    fn make_content_conflict(repo: &TempRepo) {
        repo.write("shared.txt", "line1\nbase\nline3\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "line1\nFEATURE\nline3\n");
        repo.commit_all("feature");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "line1\nMAIN\nline3\n");
        repo.commit_all("main");
        repo.git_ok(&["checkout", "-q", "feature"]);
        let _ = repo.git(&["merge", "--no-edit", "main"]); // conflicts; non-zero status expected
    }

    #[test]
    fn reconstruct_produces_markers_and_matches_side_after_checkout_ours() {
        let repo = TempRepo::new();
        make_content_conflict(&repo);
        // Remove markers, leave working tree == ours (stage 2).
        repo.git_ok(&["checkout", "--ours", "--", "shared.txt"]);
        let rec = reconstruct_conflict_impl(&repo.cwd(), "shared.txt").unwrap();
        assert!(rec.content.contains("<<<<<<<"), "reconstructed content must carry conflict markers");
        assert!(rec.content.contains(">>>>>>>"));
        assert!(rec.wt_matches_side, "working tree == ours → matches a side");
    }

    #[test]
    fn reconstruct_flags_manual_edit_when_wt_matches_no_side() {
        let repo = TempRepo::new();
        make_content_conflict(&repo);
        // Working tree is a distinct manual resolution (matches neither ours nor theirs).
        repo.write("shared.txt", "line1\nMANUAL RESOLUTION\nline3\n");
        let rec = reconstruct_conflict_impl(&repo.cwd(), "shared.txt").unwrap();
        assert!(rec.content.contains("<<<<<<<"));
        assert!(!rec.wt_matches_side, "working tree matches neither side → manual edit");
    }

    // ── Remote selection + unpushed-tag detection ─────────────
    //
    // Reproduces the "push modal lists already-pushed tags" bug: with two
    // remotes (`fork` + `origin`), `git remote -v` sorts `fork` first, so the
    // old code probed the fork (which has no tags) and reported every local
    // tag as unpushed.

    fn make_bare_remote() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gitwand-ops-bare-{}-{}-{}", pid, n, nanos));
        let out = Command::new(git_binary())
            .args(["init", "--bare", "-q", "-b", "main"])
            .arg(&dir)
            .output()
            .expect("git init --bare spawn");
        assert!(out.status.success(), "git init --bare failed: {}", String::from_utf8_lossy(&out.stderr));
        dir
    }

    #[test]
    fn git_remote_info_prefers_origin_over_alphabetically_first() {
        let repo = TempRepo::new();
        // `fork` sorts before `origin` in `git remote -v`.
        repo.git_ok(&["remote", "add", "fork", "git@github.com:someone/fork.git"]);
        repo.git_ok(&["remote", "add", "origin", "git@github.com:owner/repo.git"]);

        let info = tauri::async_runtime::block_on(git_remote_info(repo.cwd()))
            .expect("git_remote_info failed");
        assert_eq!(
            info.name, "origin",
            "origin must win over an alphabetically-earlier remote"
        );
    }

    #[test]
    fn git_remote_info_falls_back_to_sole_remote() {
        let repo = TempRepo::new();
        repo.git_ok(&["remote", "add", "upstream", "git@github.com:up/stream.git"]);

        let info = tauri::async_runtime::block_on(git_remote_info(repo.cwd()))
            .expect("git_remote_info failed");
        assert_eq!(info.name, "upstream", "the only remote is the answer");
    }

    #[test]
    fn git_unpushed_tags_reflects_what_the_remote_actually_has() {
        let repo = TempRepo::new();
        repo.write("a.txt", "1");
        repo.commit_all("c1");
        let bare = make_bare_remote();
        repo.git_ok(&["remote", "add", "origin", bare.to_str().unwrap()]);
        repo.git_ok(&["push", "-q", "origin", "main"]);

        // A tag that lives on origin must NOT be reported as unpushed.
        repo.git_ok(&["tag", "v1.0.0"]);
        repo.git_ok(&["push", "-q", "origin", "v1.0.0"]);
        let unpushed = tauri::async_runtime::block_on(
            git_unpushed_tags(repo.cwd(), "origin".to_string()),
        )
        .expect("git_unpushed_tags failed");
        assert!(
            unpushed.is_empty(),
            "v1.0.0 is on origin, expected none unpushed, got {:?}",
            unpushed
        );

        // A local-only tag IS unpushed.
        repo.git_ok(&["tag", "v2.0.0"]);
        let unpushed2 = tauri::async_runtime::block_on(
            git_unpushed_tags(repo.cwd(), "origin".to_string()),
        )
        .expect("git_unpushed_tags failed");
        assert_eq!(
            unpushed2,
            vec!["v2.0.0".to_string()],
            "only the local-only tag is unpushed"
        );

        let _ = std::fs::remove_dir_all(&bare);
    }
}

#[cfg(test)]
mod interactive_rebase_tests {
    use super::*;
    use crate::git::cmd::git_binary;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempRepo {
        path: PathBuf,
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    impl TempRepo {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir =
                std::env::temp_dir().join(format!("gitwand-rebase-test-{}-{}-{}", pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }
        fn cwd(&self) -> String {
            self.path.to_str().unwrap().to_string()
        }
        fn git(&self, args: &[&str]) -> std::process::Output {
            Command::new(git_binary())
                .args(args)
                .current_dir(&self.path)
                .output()
                .unwrap_or_else(|e| panic!("git {:?} spawn: {}", args, e))
        }
        fn git_ok(&self, args: &[&str]) {
            let out = self.git(args);
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        fn write(&self, rel: &str, content: &str) {
            std::fs::write(self.path.join(rel), content).unwrap();
        }
        fn commit_all(&self, msg: &str) {
            self.git_ok(&["add", "-A"]);
            self.git_ok(&["commit", "-q", "-m", msg]);
        }
        fn sha(&self, rev: &str) -> String {
            String::from_utf8_lossy(&self.git(&["rev-parse", rev]).stdout)
                .trim()
                .to_string()
        }
        fn log_subjects(&self) -> String {
            String::from_utf8_lossy(&self.git(&["log", "--format=%s"]).stdout).to_string()
        }
    }

    fn run(
        repo: &TempRepo,
        base: &str,
        todo: Vec<String>,
    ) -> Result<InteractiveRebaseResult, String> {
        tauri::async_runtime::block_on(git_interactive_rebase(repo.cwd(), base.to_string(), todo))
    }

    #[test]
    fn applies_an_injected_todo_and_drops_a_commit() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("A base");
        repo.write("b.txt", "b\n");
        repo.commit_all("B drop me");
        repo.write("c.txt", "c\n");
        repo.commit_all("C keep");

        // Rebase the two commits after the base, dropping the middle one.
        let base = repo.sha("HEAD~2");
        let todo = vec![
            format!("drop {} B drop me", repo.sha("HEAD~1")),
            format!("pick {} C keep", repo.sha("HEAD")),
        ];
        let res = run(&repo, &base, todo).expect("clean rebase should succeed");

        assert!(!res.conflict, "a clean drop must not report a conflict");
        let subjects = repo.log_subjects();
        assert!(
            !subjects.contains("B drop me"),
            "dropped commit should be gone: {subjects}"
        );
        assert!(subjects.contains("C keep"), "kept commit should remain");
        assert!(
            !repo.path.join("b.txt").exists(),
            "dropped commit's file must be absent"
        );
        assert!(repo.path.join("c.txt").exists(), "kept commit's file remains");
    }

    #[test]
    fn reports_conflict_when_a_reorder_clashes() {
        let repo = TempRepo::new();
        repo.write("f.txt", "line1\n");
        repo.commit_all("base");
        repo.write("f.txt", "line1-v2\n");
        repo.commit_all("v2");
        repo.write("f.txt", "line1-v3\n");
        repo.commit_all("v3");

        // Swap the two edits to the same line — replaying them out of order
        // forces a 3-way conflict, which the command must surface.
        let base = repo.sha("HEAD~2");
        let todo = vec![
            format!("pick {} v3", repo.sha("HEAD")),
            format!("pick {} v2", repo.sha("HEAD~1")),
        ];
        let res = run(&repo, &base, todo).expect("a conflict is a normal result, not an error");

        assert!(res.conflict, "a clashing reorder must report a conflict");
        // The repo is left mid-rebase; TempRepo's Drop cleans it up.
        let _ = repo.git(&["rebase", "--abort"]);
    }
}

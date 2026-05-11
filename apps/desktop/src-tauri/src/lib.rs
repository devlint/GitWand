pub(crate) mod git;
pub(crate) mod types;
pub(crate) mod commands;

pub(crate) use crate::types::*;
// Used only by the `#[cfg(test)] mod tests` block below (parse_gh_pr_json,
// parse_gh_issue_json, parse_wip_status reference). Production code in
// lib.rs no longer reaches into `crate::git` after the §3.4h split — all
// callers moved to `commands::read::*`.
#[allow(unused_imports)]
pub(crate) use crate::git::*;

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

// ─── Git read commands → commands/read.rs ─────────────────────
// (git_status, git_diff, git_log, git_repo_state, git_show,
//  git_file_log{,_pickaxe,_range}, git_blame, preview_merge — §3.4h)
//
// Parity wrappers below remain in lib.rs and route through
// `commands::read::*`. Internal helpers (libgit2_branch_status,
// libgit2_file_statuses, compute_push_remote_via_cli, git_status_cli,
// merge_file_preview) live there alongside their only callers.


// `gh_*` commands (list_prs, create_pr, list_reviewer_candidates,
// checkout_pr, merge_pr, pr_detail, pr_diff, pr_checks) migrated to
// `src/commands/gh.rs` (§3.4e). Handler entries below route to
// `commands::gh::*`.

// `parse_gh_pr_json` + `gh_pr_raw_to_pr` migrated to `src/git/parse.rs`
// as part of §3.4 (lib.rs split). Resolved here via the glob
// `pub(crate) use crate::git::*;` at the top of this file.

// gh_create_pr → commands/gh.rs

// gh_list_reviewer_candidates → commands/gh.rs

// gh_checkout_pr → commands/gh.rs

// gh_merge_pr → commands/gh.rs

// gh_pr_detail → commands/gh.rs

// gh_pr_diff → commands/gh.rs

// gh_pr_checks → commands/gh.rs

// ─── Read .gitwandrc ──────────────────────────────────────


// ─── Claude Code CLI (piggyback on user's local install) ─────
//
// Wraps the official `claude` CLI (Claude Code) so GitWand can use the
// user's existing Claude Max/Pro subscription without implementing OAuth
// ourselves. Inspired by Solo's approach, but headless (no PTY): we only
// need one-shot prompts for commit messages, merge resolution and PR review.

// `ClaudeCliInfo` struct + `CLAUDE_AUTH_OVERRIDE_ENV` const migrated
// to `src/types.rs` as part of §3.4. Resolved here via
// `pub(crate) use crate::types::*;`.

// `strip_claude_auth_env` + `resolve_claude_binary` + `resolve_codex_binary`
// + 5 AI CLI commands (detect_claude_cli, claude_cli_prompt, detect_codex_cli,
// codex_cli_prompt, claude_cli_login) migrated to `src/commands/ai.rs` (§3.4f).
// Handler entries below route to `commands::ai::*`.

// ─── Workspaces ───────────────────────────────────────────────

// `WorkspaceRepo` and `WorkspaceConfig` migrated to `src/types.rs` as
// part of §3.4. Resolved here via `pub(crate) use crate::types::*;`.

// `WorkspaceRepoStatus`, `WorkspaceWipItem`, and `WorkspaceRepoPrs`
// migrated to `src/types.rs` as part of §3.4. Resolved here via
// `pub(crate) use crate::types::*;`.

// `Issue`, `GhIssue*` deserialization helpers, `parse_gh_issue_json`,
// and `WorkspaceRepoIssues` migrated to `src/types.rs` and
// `src/git/parse.rs` as part of §3.4. Resolved here via
// `pub(crate) use crate::types::*;` and `pub(crate) use crate::git::*;`.

// `workspace_read` + `workspace_write` migrated to
// `src/commands/workspace.rs` (§3.4). The handler entries below now
// point to `commands::workspace::*`.

// `libgit2_*` helpers + `format_iso8601` + `unix_to_ymdhms` migrated
// to `src/git/libgit2.rs` (§3.4 / P3.3a).
// `workspace_status_all` + `workspace_fetch_all` + `workspace_pull_all`
// + `workspace_wip_all` + `workspace_prs_all` + `workspace_issues_all`
// migrated to `src/commands/workspace.rs` (§3.4). Handler entries below
// route to `commands::workspace::*`.

// detect_claude_cli → commands/ai.rs

// claude_cli_prompt → commands/ai.rs

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

// `CodexCliInfo` migrated to `src/types.rs` as part of §3.4.
// Resolved here via `pub(crate) use crate::types::*;`.

// resolve_codex_binary → commands/ai.rs

// detect_codex_cli → commands/ai.rs

// codex_cli_prompt → commands/ai.rs

// ─── Clone & Fork (v2.0) ───────────────────────────────────
//
// Both commands are synchronous shell-outs that block on completion.
// Real-time progress events are deliberately deferred — they'd require
// introducing async commands + Tauri event emit + SSE on the dev-server,
// which is a chantier of its own. The frontend shows a spinner while
// these run; on a fast network a typical clone is sub-second to a few
// seconds and the spinner is acceptable.

// claude_cli_login → commands/ai.rs

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

/// Parity entry point — explicitly calls the CLI-backed implementation.
/// The user-facing `git_status` Tauri command uses libgit2 (P3.3b), but
/// parity tests must compare against the CLI implementation that the Node
/// dev-server also uses. Don't redirect this to the libgit2 version.
pub fn git_status_parity(cwd: String) -> Result<GitStatus, String> {
    commands::read::git_status_cli(cwd)
}

/// Bench entry point — calls the libgit2 fast path *in isolation*, so the
/// bench can measure it directly without the CLI fallback masking the
/// numbers. NOT used for parity testing — the libgit2 output may diverge
/// from CLI on edge cases (and the CLI fallback handles those at runtime).
///
/// The bench runs both `git_status_parity` (CLI) and this function
/// (libgit2) on the same fixture so the delta is visible.
pub fn git_status_libgit2_parity(cwd: String) -> Result<GitStatus, String> {
    commands::read::git_status_libgit2(&cwd)
}

pub fn git_log_parity(
    cwd: String,
    count: Option<i32>,
    all: Option<bool>,
    author: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    commands::read::git_log(cwd, count, all, author)
}

pub fn git_branches_parity(cwd: String) -> Result<Vec<types::GitBranch>, String> {
    commands::ops::git_branches(cwd)
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
            commands::ops::get_conflicted_files,
            commands::files::read_file,
            commands::files::write_file,
            commands::files::write_gitwandrc,
            commands::files::read_file_at_revision,
            commands::files::folder_diff,
            commands::files::list_dir,
            commands::read::git_status,
            commands::read::git_diff,
            commands::read::git_log,
            commands::ops::git_stage,
            commands::ops::git_unstage,
            commands::ops::git_stage_patch,
            commands::ops::git_unstage_patch,
            commands::ops::git_commit,
            commands::ops::git_amend_commit,
            commands::ops::git_split_commit,
            commands::ops::git_push,
            commands::ops::git_pull,
            commands::ops::git_fetch,
            commands::ops::git_merge,
            commands::ops::git_merge_abort,
            commands::ops::git_merge_continue,
            commands::read::git_repo_state,
            commands::ops::git_rebase_action,
            commands::ops::git_discard,
            commands::read::git_show,
            commands::ops::git_branches,
            commands::ops::git_create_branch,
            commands::ops::git_switch_branch,
            commands::ops::git_delete_branch,
            commands::ops::git_rename_branch,
            commands::ops::git_stash,
            commands::ops::git_stash_pop,
            commands::ops::open_in_editor,
            commands::ops::set_git_config,
            commands::ops::read_gitwandrc,
            commands::read::preview_merge,
            commands::ops::git_conflict_check,
            commands::ops::git_cherry_pick,
            commands::ops::git_cherry_pick_abort,
            commands::ops::git_cherry_pick_continue,
            commands::ops::git_stash_list,
            commands::ops::git_stash_apply,
            commands::ops::git_stash_drop,
            commands::ops::git_stash_show,
            commands::ops::detect_monorepo,
            commands::ops::git_remote_info,
            commands::gh::gh_list_prs,
            commands::gh::gh_create_pr,
            commands::gh::gh_list_reviewer_candidates,
            commands::gh::gh_checkout_pr,
            commands::gh::gh_merge_pr,
            commands::gh::gh_pr_detail,
            commands::gh::gh_pr_diff,
            commands::gh::gh_pr_checks,
            commands::ops::git_exec,
            commands::ops::git_autocomplete,
            commands::ops::git_get_user,
            commands::ai::detect_claude_cli,
            commands::ai::claude_cli_prompt,
            commands::ai::claude_cli_login,
            commands::ops::git_hook_list,
            commands::ops::git_hook_toggle,
            commands::ops::git_hook_create,
            commands::ops::git_hook_delete,
            commands::ops::shell_exec,
            commands::workspace::workspace_read,
            commands::workspace::workspace_write,
            commands::workspace::workspace_status_all,
            commands::workspace::workspace_fetch_all,
            commands::workspace::workspace_pull_all,
            commands::workspace::workspace_wip_all,
            commands::workspace::workspace_prs_all,
            commands::workspace::workspace_issues_all,
            commands::ops::git_worktree_status_all,
            commands::ops::git_worktree_list,
            commands::ops::git_worktree_add,
            commands::ops::git_worktree_remove,
            commands::ops::git_worktree_prune,
            commands::ops::agent_session_list,
            commands::ops::agent_session_launch,
            commands::ops::git_submodule_list,
            commands::ops::git_submodule_init,
            commands::ops::git_submodule_update,
            commands::ops::git_submodule_add,
            commands::read::git_file_log,
            commands::read::git_file_log_pickaxe,
            commands::read::git_file_log_range,
            commands::read::git_blame,
            commands::ops::git_checkout_commit,
            commands::ops::git_reset_to_commit,
            commands::ops::git_revert_commit,
            commands::ops::git_create_tag,
            commands::ops::git_list_tags,
            commands::ops::git_delete_tag,
            commands::ops::git_push_tags,
            commands::ops::git_unpushed_tags,
            commands::ops::git_delete_remote_tag,
            commands::ops::git_clone,
            commands::ops::gh_fork,
            commands::ops::git_shortlog,
            commands::ops::gh_current_user,
            commands::ops::pr_files,
            commands::ai::detect_codex_cli,
            commands::ai::codex_cli_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitWand");
}

// `parse_wip_status` lives in `src/git/parse.rs`. Tests below import it via
// `use super::*` + the glob `pub(crate) use crate::git::*;` re-export at the
// top of this file.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_pr_list() {
        let result = parse_gh_pr_json("[]").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_empty_string() {
        let result = parse_gh_pr_json("").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_single_basic_pr() {
        let json = r#"[{
          "number": 42,
          "title": "Add feature",
          "state": "OPEN",
          "author": {"login": "alice"},
          "headRefName": "feature/foo",
          "baseRefName": "main",
          "isDraft": false,
          "createdAt": "2026-01-01T00:00:00Z",
          "updatedAt": "2026-01-02T00:00:00Z",
          "url": "https://github.com/org/repo/pull/42",
          "additions": 10,
          "deletions": 3,
          "labels": [{"name": "bug"}],
          "assignees": [{"login": "bob"}],
          "reviewRequests": [{"requestedReviewer": {"login": "carol"}}],
          "reviewDecision": "REVIEW_REQUIRED",
          "mergeStateStatus": "BLOCKED",
          "statusCheckRollup": [{"conclusion": "SUCCESS"}]
        }]"#;
        let prs = parse_gh_pr_json(json).unwrap();
        assert_eq!(prs.len(), 1);
        let pr = &prs[0];
        assert_eq!(pr.number, 42);
        assert_eq!(pr.title, "Add feature");
        assert_eq!(pr.author, "alice");
        assert_eq!(pr.branch, "feature/foo");
        assert_eq!(pr.base, "main");
        assert!(!pr.draft);
        assert_eq!(pr.labels, vec!["bug"]);
        assert_eq!(pr.assignees, vec!["bob"]);
        assert_eq!(pr.review_requested, vec!["carol"]);
        assert_eq!(pr.review_decision, "REVIEW_REQUIRED");
        assert_eq!(pr.merge_state_status, "BLOCKED");
        assert_eq!(pr.checks_rollup, "SUCCESS");
    }

    #[test]
    fn parse_pr_with_braces_in_title_does_not_silently_drop() {
        // Regression test: the old char-scanning parser broke when PR titles
        // or branch names contained '{' or '}', silently producing 0 results.
        let json = r#"[{
          "number": 1,
          "title": "Fix {broken} thing",
          "state": "OPEN",
          "author": {"login": "alice"},
          "headRefName": "fix/{broken}",
          "baseRefName": "main",
          "isDraft": false,
          "createdAt": "2026-01-01T00:00:00Z",
          "updatedAt": "2026-01-01T00:00:00Z",
          "url": "https://github.com/org/repo/pull/1",
          "additions": 1,
          "deletions": 1,
          "labels": [],
          "assignees": [],
          "reviewRequests": [],
          "reviewDecision": null,
          "mergeStateStatus": null,
          "statusCheckRollup": []
        }]"#;
        let prs = parse_gh_pr_json(json).unwrap();
        assert_eq!(prs.len(), 1, "PR with braces in title must not be dropped");
        assert_eq!(prs[0].title, "Fix {broken} thing");
        assert_eq!(prs[0].branch, "fix/{broken}");
        assert_eq!(prs[0].review_decision, "");
        assert_eq!(prs[0].merge_state_status, "");
        assert_eq!(prs[0].checks_rollup, "");
    }

    #[test]
    fn parse_multiple_prs_all_parsed() {
        let json = r#"[
          {"number":1,"title":"A","state":"OPEN","author":{"login":"x"},
           "headRefName":"a","baseRefName":"main","isDraft":false,
           "createdAt":"","updatedAt":"","url":"","additions":0,"deletions":0,
           "labels":[],"assignees":[],"reviewRequests":[],
           "reviewDecision":null,"mergeStateStatus":null,"statusCheckRollup":[]},
          {"number":2,"title":"B","state":"OPEN","author":{"login":"y"},
           "headRefName":"b","baseRefName":"main","isDraft":true,
           "createdAt":"","updatedAt":"","url":"","additions":5,"deletions":2,
           "labels":[{"name":"wip"}],"assignees":[],"reviewRequests":[],
           "reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","statusCheckRollup":[]}
        ]"#;
        let prs = parse_gh_pr_json(json).unwrap();
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].number, 1);
        assert_eq!(prs[1].number, 2);
        assert!(prs[1].draft);
        assert_eq!(prs[1].review_decision, "APPROVED");
    }

    #[test]
    fn wip_status_empty() {
        let (s, u, t) = parse_wip_status("");
        assert_eq!((s, u, t), (0, 0, 0));
    }

    #[test]
    fn wip_status_untracked_only() {
        let out = "?? new_file.rs\n?? another.txt\n";
        let (s, u, t) = parse_wip_status(out);
        assert_eq!(s, 0, "no staged");
        assert_eq!(u, 0, "no unstaged");
        assert_eq!(t, 2, "two untracked");
    }

    #[test]
    fn wip_status_staged_only() {
        // Format: "XY filename" — X=index status, Y=worktree status, space before filename
        // "A " = X=A (added to index), Y=' ' (clean worktree) → staged only
        // "M " = X=M (modified in index), Y=' ' (clean worktree) → staged only
        // The double space: XY + separator space = "A  filename"
        let out = "A  staged_new.rs\nM  staged_mod.rs\n";
        let (s, u, t) = parse_wip_status(out);
        assert_eq!(s, 2, "two staged");
        assert_eq!(u, 0, "no unstaged");
        assert_eq!(t, 0, "no untracked");
    }

    #[test]
    fn wip_status_unstaged_only() {
        // " M" = clean index, modified worktree
        let out = " M worktree_mod.rs\n D deleted_worktree.rs\n";
        let (s, u, t) = parse_wip_status(out);
        assert_eq!(s, 0, "no staged");
        assert_eq!(u, 2, "two unstaged");
        assert_eq!(t, 0, "no untracked");
    }

    #[test]
    fn wip_status_mixed() {
        // MM = both staged and unstaged modifications to same file
        let out = "MM both.rs\nA  staged.rs\n?? untracked.rs\n M unstaged.rs\n";
        let (s, u, t) = parse_wip_status(out);
        // "MM": X=M (staged), Y=M (unstaged)
        // "A ": X=A (staged), Y=' ' (not unstaged)
        // "??": untracked
        // " M": X=' ' (not staged), Y=M (unstaged)
        assert_eq!(s, 2, "MM + A = 2 staged");
        assert_eq!(u, 2, "MM + M = 2 unstaged");
        assert_eq!(t, 1, "one untracked");
    }

    #[test]
    fn wip_status_whitespace_only() {
        // git status --porcelain may emit a trailing newline with no content lines
        let out = "\n";
        let (s, u, t) = parse_wip_status(out);
        assert_eq!((s, u, t), (0, 0, 0), "trailing newline only = empty");
    }

    #[test]
    fn wip_status_conflicts() {
        // Merge-conflict codes (UU, AA, etc.) count in both staged and unstaged
        // because U != ' '/'?'/'!' for both X and Y.
        // This is intentional: conflict files show up as "active" in both dimensions.
        let out = "UU conflict.rs\nAA added_both.rs\n";
        let (s, u, t) = parse_wip_status(out);
        assert_eq!(s, 2, "UU and AA both staged (X = U or A)");
        assert_eq!(u, 2, "UU and AA both unstaged (Y = U or A)");
        assert_eq!(t, 0, "no untracked");
    }

    #[test]
    fn workspace_repo_prs_serializes_camel_case_fields() {
        let item = WorkspaceRepoPrs {
            repo_path: "/path/to/repo".to_string(),
            repo_name: "my-repo".to_string(),
            prs: vec![],
            error: None,
        };
        let json = serde_json::to_string(&item).unwrap();
        // #[serde(rename_all = "camelCase")] must produce camelCase keys
        assert!(json.contains("\"repoPath\""), "repo_path should serialize as repoPath, got: {}", json);
        assert!(json.contains("\"repoName\""), "repo_name should serialize as repoName, got: {}", json);
        assert!(!json.contains("\"repo_path\""), "snake_case must not appear: {}", json);
        assert!(!json.contains("\"repo_name\""), "snake_case must not appear: {}", json);
        assert!(json.contains("\"prs\""), "prs field must appear in JSON, got: {}", json);
    }

    #[test]
    fn workspace_repo_prs_error_serializes() {
        let item = WorkspaceRepoPrs {
            repo_path: "/path".to_string(),
            repo_name: "repo".to_string(),
            prs: vec![],
            error: Some("gh: command not found".to_string()),
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"gh: command not found\""), "error message must appear in JSON");
        // error field itself should be camelCase (it's a single word, stays "error")
        assert!(json.contains("\"error\":\"gh: command not found\""), "error key+value must appear together: {}", json);
    }

    #[test]
    fn parse_empty_issue_list() {
        let result = parse_gh_issue_json("[]").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_empty_issue_string() {
        let result = parse_gh_issue_json("").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_single_issue_all_fields() {
        let json = r#"[{
          "number": 7,
          "title": "Fix crash on startup",
          "state": "OPEN",
          "author": {"login": "alice"},
          "assignees": [{"login": "bob"}],
          "labels": [{"name": "bug"}, {"name": "urgent"}],
          "url": "https://github.com/org/repo/issues/7",
          "createdAt": "2026-03-01T10:00:00Z",
          "updatedAt": "2026-03-02T12:00:00Z",
          "milestone": {"title": "v2.9.0"}
        }]"#;
        let issues = parse_gh_issue_json(json).unwrap();
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.number, 7);
        assert_eq!(issue.title, "Fix crash on startup");
        assert_eq!(issue.state, "OPEN");
        assert_eq!(issue.author, "alice");
        assert_eq!(issue.assignees, vec!["bob"]);
        assert_eq!(issue.labels, vec!["bug", "urgent"]);
        assert_eq!(issue.url, "https://github.com/org/repo/issues/7");
        assert_eq!(issue.created_at, "2026-03-01T10:00:00Z");
        assert_eq!(issue.updated_at, "2026-03-02T12:00:00Z");
        assert_eq!(issue.milestone, "v2.9.0");
    }

    #[test]
    fn parse_issue_without_milestone() {
        let json = r#"[{
          "number": 1,
          "title": "Simple issue",
          "state": "OPEN",
          "author": {"login": "alice"},
          "url": "https://github.com/org/repo/issues/1",
          "createdAt": "2026-01-01T00:00:00Z",
          "updatedAt": "2026-01-01T00:00:00Z"
        }]"#;
        let issues = parse_gh_issue_json(json).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].milestone, "", "milestone should be empty string when absent");
        assert!(issues[0].assignees.is_empty());
        assert!(issues[0].labels.is_empty());
    }

    #[test]
    fn test_changed_files_extraction() {
        // Helper that mirrors the changed_files extraction logic in get_workspace_wip
        fn extract(status_out: &str) -> Vec<String> {
            let mut seen = std::collections::HashSet::new();
            for line in status_out.lines() {
                if line.len() < 4 { continue; }
                if &line[0..2] == "??" { continue; }
                let path_part = &line[3..];
                let path = if path_part.contains(" -> ") {
                    path_part.split(" -> ").last().unwrap_or(path_part).trim()
                } else {
                    path_part.trim()
                };
                let path = path.trim_matches('"');
                if !path.is_empty() {
                    seen.insert(path.to_string());
                }
            }
            let mut v: Vec<String> = seen.into_iter().collect();
            v.sort();
            v
        }

        // Normal modified file
        assert_eq!(extract(" M src/main.rs\n"), vec!["src/main.rs"]);

        // Untracked file is skipped
        assert_eq!(extract("?? untracked.rs\n"), Vec::<String>::new());

        // Rename: take the new path
        assert_eq!(extract("R  old.rs -> new.rs\n"), vec!["new.rs"]);

        // File with spaces: quotes stripped
        assert_eq!(extract(" M \"new file.ts\"\n"), vec!["new file.ts"]);

        // Rename with spaces: new path, quotes stripped
        assert_eq!(extract("R  \"old file.ts\" -> \"new file.ts\"\n"), vec!["new file.ts"]);

        // Deduplication
        assert_eq!(
            extract(" M src/auth.ts\nM  src/auth.ts\n"),
            vec!["src/auth.ts"]
        );

        // Mixed: modified + untracked
        assert_eq!(
            extract(" M src/auth.ts\n?? ignored.ts\n"),
            vec!["src/auth.ts"]
        );
    }
}

/**
 * Which dev-server route stands in for each Tauri command the frontend calls —
 * or why none does.
 *
 * `pnpm dev:web` runs `dev-server.mjs`, not the Rust backend. A command whose
 * route is missing or differs makes manual QA test something other than what
 * ships: that is how `gl_merge_mr`'s broken `glab` flag survived, and how
 * `read_file` disagreed with Rust on non-UTF-8 input while agreeing on
 * everything else.
 *
 * There is no rule mapping a command name to a route name —
 * `get_conflicted_files` is served by `/api/conflicted-files`,
 * `git_add_to_gitignore` by `/api/git-gitignore` — so the correspondence is
 * declared here rather than inferred, and `commandRegistry.test.ts` fails when
 * this file stops matching reality.
 *
 * Design: docs/superpowers/specs/2026-09-18-command-route-registry-design.md
 */

export interface CommandRegistryEntry {
  /** The dev-server route that stands in for this command, e.g. "/api/git-merge". */
  route?: string;
  /**
   * Why this command has no route, in prose. Mandatory when `route` is absent:
   * an entry that says "desktop only" without saying why is worth no more than
   * a missing route, because the next reader still cannot tell a deliberate
   * choice from an oversight.
   *
   * A reason starting with `GAP:` marks a command that *could* have a route and
   * simply does not. Those are the findings of the audit that produced this
   * file, not settled decisions.
   */
  desktopOnly?: string;
  /**
   * The route exists but implements only one of the command's two paths: the
   * dev-server shells out to a CLI where the Rust command uses a REST API once
   * a token is configured. Documentation, not behaviour — the route keeps
   * answering exactly as it does today.
   */
  cliPathOnly?: string;
}

export const COMMAND_REGISTRY: Record<string, CommandRegistryEntry> = {
  // `cliPathOnly` below is **not exhaustive**. It marks the four commands whose
  // Rust body branches on `settings_github_token()` directly. Others reach the
  // same branch through helpers (`gh_list_prs_inner` and friends), and finding
  // them means following call chains this audit did not undertake. Treat an
  // absent `cliPathOnly` on a forge command as "not checked", not as "agrees".
  agent_session_launch: { route: "/api/agent-session-launch" },
  agent_session_list: { route: "/api/agent-session-list" },
  bb_list_issues: { route: "/api/bb-list-issues" },
  check_remote_reachable: { route: "/api/check-remote-reachable" },
  detect_monorepo: { route: "/api/detect-monorepo" },
  folder_diff: { route: "/api/folder-diff" },
  gh_fork: { route: "/api/gh-fork" },
  gh_issue_comments: {
    route: "/api/gh-issue-comments",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  gh_issue_detail: {
    route: "/api/gh-issue-detail",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  gh_list_issues: { route: "/api/gh-list-issues" },
  git_amend_commit: { route: "/api/git-amend-commit" },
  git_author_line_stats: { route: "/api/git-author-line-stats" },
  git_blame: { route: "/api/git-blame" },
  git_branch_merged: { route: "/api/git-branch-merged" },
  git_branch_top_authors: { route: "/api/git-branch-top-authors" },
  git_branches: { route: "/api/git-branches" },
  git_checkout_commit: { route: "/api/git-checkout-commit" },
  git_cherry_pick: { route: "/api/git-cherry-pick" },
  git_clone: { route: "/api/git-clone" },
  git_commit: { route: "/api/git-commit" },
  git_commit_submodule_changes: { route: "/api/git-commit-submodule-changes" },
  git_create_branch: { route: "/api/git-create-branch" },
  git_create_tag: { route: "/api/git-create-tag" },
  git_delete_branch: { route: "/api/git-delete-branch" },
  git_delete_remote_branch: { route: "/api/git-delete-remote-branch" },
  git_delete_remote_tag: { route: "/api/git-delete-remote-tag" },
  git_delete_tag: { route: "/api/git-delete-tag" },
  git_diff: { route: "/api/git-diff" },
  git_discard: { route: "/api/git-discard" },
  git_exec: { route: "/api/git-exec" },
  git_fetch: { route: "/api/git-fetch" },
  git_file_diff: { route: "/api/git-file-diff" },
  git_file_log: { route: "/api/git-file-log" },
  git_file_log_pickaxe: { route: "/api/git-file-log-pickaxe" },
  git_file_log_range: { route: "/api/git-file-log-range" },
  git_get_user: { route: "/api/git-get-user" },
  git_hook_create: { route: "/api/git-hook-create" },
  git_hook_delete: { route: "/api/git-hook-delete" },
  git_hook_list: { route: "/api/git-hook-list" },
  git_hook_toggle: { route: "/api/git-hook-toggle" },
  git_interactive_rebase: { route: "/api/git-interactive-rebase" },
  git_list_tags: { route: "/api/git-list-tags" },
  git_log: { route: "/api/git-log" },
  git_merge: { route: "/api/git-merge" },
  git_merge_base: { route: "/api/git-merge-base" },
  git_operation_action: { route: "/api/git-operation-action" },
  git_pull: { route: "/api/git-pull" },
  git_push: { route: "/api/git-push" },
  git_push_tags: { route: "/api/git-push-tags" },
  git_rebase_onto: { route: "/api/git-rebase-onto" },
  git_remote_info: { route: "/api/git-remote-info" },
  git_rename_branch: { route: "/api/git-rename-branch" },
  git_repo_state: { route: "/api/git-repo-state" },
  git_reset_to_commit: { route: "/api/git-reset-to-commit" },
  git_rev_count: { route: "/api/git-rev-count" },
  git_revert_commit: { route: "/api/git-revert-commit" },
  git_shortlog: { route: "/api/git-shortlog" },
  git_show: { route: "/api/git-show" },
  git_split_commit: { route: "/api/git-split-commit" },
  git_stage: { route: "/api/git-stage" },
  git_stage_patch: { route: "/api/git-stage-patch" },
  git_stash: { route: "/api/git-stash" },
  git_stash_apply: { route: "/api/git-stash-apply" },
  git_stash_clear: { route: "/api/git-stash-clear" },
  git_stash_drop: { route: "/api/git-stash-drop" },
  git_stash_list: { route: "/api/git-stash-list" },
  git_stash_pop: { route: "/api/git-stash-pop" },
  git_stash_show: { route: "/api/git-stash-show" },
  git_status: { route: "/api/git-status" },
  git_submodule_add: { route: "/api/git-submodule-add" },
  git_submodule_branches: { route: "/api/git-submodule-branches" },
  git_submodule_check_updates: { route: "/api/git-submodule-check-updates" },
  git_submodule_init: { route: "/api/git-submodule-init" },
  git_submodule_list: { route: "/api/git-submodule-list" },
  git_submodule_update: { route: "/api/git-submodule-update" },
  git_submodule_update_one: { route: "/api/git-submodule-update-one" },
  git_switch_branch: { route: "/api/git-switch-branch" },
  git_unpushed_tags: { route: "/api/git-unpushed-tags" },
  git_unstage: { route: "/api/git-unstage" },
  git_unstage_patch: { route: "/api/git-unstage-patch" },
  git_worktree_add: { route: "/api/git-worktree-add" },
  git_worktree_list: { route: "/api/git-worktree-list" },
  git_worktree_prune: { route: "/api/git-worktree-prune" },
  git_worktree_remove: { route: "/api/git-worktree-remove" },
  git_worktree_repair: { route: "/api/git-worktree-repair" },
  git_worktree_status_all: { route: "/api/git-worktree-status-all" },
  gl_list_issues: { route: "/api/gl-list-issues" },
  list_dir: { route: "/api/list-dir" },
  list_repo_tree: { route: "/api/list-repo-tree" },
  path_exists: { route: "/api/path-exists" },
  preview_cherry_pick: { route: "/api/preview-cherry-pick" },
  preview_merge: { route: "/api/preview-merge" },
  preview_rebase: { route: "/api/preview-rebase" },
  read_file: { route: "/api/read-file" },
  read_file_at_revision: { route: "/api/read-file-at-revision" },
  read_gitwandrc: { route: "/api/read-gitwandrc" },
  reconstruct_conflict: { route: "/api/reconstruct-conflict" },
  resolve_tree_conflict: { route: "/api/resolve-tree-conflict" },
  scan_secrets: { route: "/api/scan-secrets" },
  scratch_worktree_create: { route: "/api/scratch-worktree-create" },
  snapshot_create: { route: "/api/snapshot-create" },
  snapshot_list: { route: "/api/snapshot-list" },
  snapshot_prune: { route: "/api/snapshot-prune" },
  snapshot_restore: { route: "/api/snapshot-restore" },
  terminal_close: { route: "/api/terminal-close" },
  terminal_open: { route: "/api/terminal-open" },
  terminal_resize: { route: "/api/terminal-resize" },
  terminal_write: { route: "/api/terminal-write" },
  watch_repo_stop: { route: "/api/watch-repo-stop" },
  workspace_fetch_all: { route: "/api/workspace-fetch-all" },
  workspace_issues_all: { route: "/api/workspace-issues-all" },
  workspace_prs_all: { route: "/api/workspace-prs-all" },
  workspace_pull_all: { route: "/api/workspace-pull-all" },
  workspace_read: { route: "/api/workspace-read" },
  workspace_status_all: { route: "/api/workspace-status-all" },
  workspace_wip_all: { route: "/api/workspace-wip-all" },
  workspace_write: { route: "/api/workspace-write" },
  write_file: { route: "/api/write-file" },
  write_gitwandrc: { route: "/api/write-gitwandrc" },

  // ─── Routes that exist under a different name ─────────────────────────────
  // No rule maps a command name to a route name; each of these was resolved by
  // reading the wrapper's own web branch in backend.ts.
  get_conflicted_files: { route: "/api/conflicted-files" },
  get_tree_conflicts: { route: "/api/tree-conflicts" },
  gh_issue_add_comment: {
    route: "/api/gh-issue-comment",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  gh_issue_set_state: {
    route: "/api/gh-issue-state",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  git_add_to_gitignore: { route: "/api/git-gitignore" },
  // Not fetched: devWatchRepoOpen opens an EventSource on this path.
  watch_repo_start: { route: "/api/watch-repo" },

  // ─── Genuinely desktop-only ───────────────────────────────────────────────
  get_command_log: {
    desktopOnly:
      "Returns cmd_log_snapshot(), an in-process record of the git commands the Rust backend itself ran. A Node dev-server has no such store to report.",
  },
  open_in_editor: {
    desktopOnly:
      "Launches the user's configured editor application. Only the packaged app runs on the desktop session that can open a window.",
  },
  shell_exec: {
    desktopOnly:
      "Runs the shell command the user authored in Settings, in their terminal. A dev-server has no terminal to attach it to.",
  },

  // ─── GAPs this audit found ────────────────────────────────────────────────
  // Nothing prevents these from having a route; they simply do not have one.
  // Listed as findings rather than dressed up as deliberate choices.
  git_commit_template_path: {
    desktopOnly:
      "GAP: the wrapper fetches /api/git-commit-template-path, which dev-server.mjs never declares — the call 404s under pnpm dev:web.",
  },
  git_config_identity: {
    desktopOnly:
      "GAP: the wrapper fetches /api/git-config-identity, which dev-server.mjs never declares — the call 404s under pnpm dev:web.",
  },
  git_autocomplete: {
    desktopOnly:
      "GAP: no dev-server route and no web branch, and nothing about branch and tag completion requires the desktop.",
  },
  git_conflict_check: {
    desktopOnly:
      "GAP: no dev-server route and no web branch, and nothing about it requires the desktop.",
  },
  set_git_config: {
    desktopOnly:
      "GAP: no dev-server route and no web branch; writing a git config value needs nothing only the desktop can do.",
  },
  scratch_worktree_discard: {
    desktopOnly:
      "GAP: git worktree remove plus prune, which a Node process runs as well as Rust does.",
  },
  scratch_worktree_merge_back: {
    desktopOnly:
      "GAP: no dev-server route and no web branch, and nothing about it requires the desktop.",
  },
  mcp_detect_configs: {
    desktopOnly:
      "GAP: reads MCP client config files by absolute path. Possible from Node, simply not implemented.",
  },
  mcp_read_config: {
    desktopOnly:
      "GAP: reads MCP client config files by absolute path. Possible from Node, simply not implemented.",
  },
  mcp_install_server: {
    desktopOnly:
      "GAP: writes MCP client config files by absolute path. Possible from Node, simply not implemented.",
  },
  mcp_uninstall_server: {
    desktopOnly:
      "GAP: writes MCP client config files by absolute path. Possible from Node, simply not implemented.",
  },
};

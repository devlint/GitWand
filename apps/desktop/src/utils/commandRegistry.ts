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
  // `cliPathOnly` below is **not exhaustive**. It marks the commands whose Rust
  // body (or its `_inner`) branches on `settings_github_token()` directly while
  // the route shells out to `gh`. Others reach the
  // same branch through helpers (`gh_list_prs_inner` and friends), and finding
  // them means following call chains this audit did not undertake. Treat an
  // absent `cliPathOnly` on a forge command as "not checked", not as "agrees".
  ai_api_key_hint: { route: "/api/ai-api-key" },
  ai_api_key_set: { route: "/api/ai-api-key" },
  ai_http_request: { route: "/api/ai-http-request" },
  antigravity_cli_prompt: { route: "/api/antigravity-cli-prompt" },
  antigravity_list_models: { route: "/api/antigravity-models" },
  claude_cli_login: { route: "/api/claude-cli-login" },
  claude_cli_prompt: { route: "/api/claude-cli-prompt" },
  codex_cli_prompt: { route: "/api/codex-cli-prompt" },
  codex_list_models: { route: "/api/codex-models" },
  copilot_cli_prompt: { route: "/api/copilot-cli-prompt" },
  copilot_list_models: { route: "/api/copilot-models" },
  detect_antigravity_cli: { route: "/api/antigravity-cli-detect" },
  detect_claude_cli: { route: "/api/claude-cli-detect" },
  detect_codex_cli: { route: "/api/codex-cli-detect" },
  detect_copilot_cli: { route: "/api/copilot-cli-detect" },
  detect_opencode_cli: { route: "/api/opencode-cli-detect" },
  opencode_cli_prompt: { route: "/api/opencode-cli-prompt" },
  opencode_list_models: { route: "/api/opencode-models" },
  agent_session_launch: { route: "/api/agent-session-launch" },
  agent_session_list: { route: "/api/agent-session-list" },
  bb_list_issues: { route: "/api/bb-list-issues" },
  check_remote_reachable: { route: "/api/check-remote-reachable" },
  detect_monorepo: { route: "/api/detect-monorepo" },
  folder_diff: { route: "/api/folder-diff" },
  gh_check_annotations: { route: "/api/gh-check-annotations" },
  gh_create_pr: { route: "/api/gh-create-pr" },
  gh_current_user: { route: "/api/gh-current-user" },
  gh_disable_auto_merge: {
    route: "/api/gh-disable-auto-merge",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  gh_dismiss_review: { route: "/api/gh-dismiss-review" },
  gh_enable_auto_merge: {
    route: "/api/gh-enable-auto-merge",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
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
  gh_list_prs: { route: "/api/gh-list-prs" },
  gh_merge_pr: {
    route: "/api/gh-merge-pr",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  gh_pr_checks: { route: "/api/gh-pr-checks" },
  gh_pr_comments: { route: "/api/gh-pr-comments" },
  gh_pr_count: { route: "/api/gh-pr-count" },
  gh_pr_detail: { route: "/api/gh-pr-detail" },
  gh_pr_diff: { route: "/api/gh-pr-diff" },
  gh_pr_issue_comments: { route: "/api/gh-pr-issue-comments" },
  gh_pr_review_threads: { route: "/api/gh-pr-review-threads" },
  gh_pr_reviews: { route: "/api/gh-pr-reviews" },
  gh_request_reviewers: { route: "/api/gh-request-reviewers" },
  gh_set_review_thread_resolved: { route: "/api/gh-set-review-thread-resolved" },
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
  git_fast_forward_to_upstream: { route: "/api/git-fast-forward-to-upstream" },
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
  git_tracked_ignored: { route: "/api/git-tracked-ignored" },
  git_untrack_paths: { route: "/api/git-untrack-paths" },
  git_unpushed_tags: { route: "/api/git-unpushed-tags" },
  git_unstage: { route: "/api/git-unstage" },
  git_unstage_patch: { route: "/api/git-unstage-patch" },
  git_worktree_add: { route: "/api/git-worktree-add" },
  git_worktree_list: { route: "/api/git-worktree-list" },
  git_worktree_prune: { route: "/api/git-worktree-prune" },
  git_worktree_remove: { route: "/api/git-worktree-remove" },
  git_worktree_repair: { route: "/api/git-worktree-repair" },
  git_worktree_status_all: { route: "/api/git-worktree-status-all" },
  // The Gitea read routes are `case` labels inside the `/api/gitea-` prefix
  // dispatcher. They read the token from GITWAND_GITEA_TOKEN (and the base URL
  // from GITWAND_GITEA_BASE) because the keychain the Rust commands use is out
  // of a Node process's reach; past auth they mirror commands/gitea.rs.
  gitea_current_user: { route: "/api/gitea-current-user" },
  gitea_get_pr: { route: "/api/gitea-get-pr" },
  gitea_list_issues: { route: "/api/gitea-list-issues" },
  gitea_list_prs: { route: "/api/gitea-list-prs" },
  gitea_pr_comments: { route: "/api/gitea-pr-comments" },
  gitea_pr_count: { route: "/api/gitea-pr-count" },
  gitea_pr_diff: { route: "/api/gitea-pr-diff" },
  gitea_pr_status: { route: "/api/gitea-pr-status" },
  // Mocks, not stand-ins: the device flow always "succeeds" as `dev-user` on
  // the third poll, and the token check always answers false. They let the
  // Settings UI be exercised; they do not exercise GitHub's OAuth endpoints.
  github_device_poll: { route: "/api/github-device-poll" },
  github_device_start: { route: "/api/github-device-start" },
  github_token_present: { route: "/api/github-token-present" },
  gl_disable_auto_merge: { route: "/api/gl-disable-auto-merge" },
  gl_enable_auto_merge: { route: "/api/gl-enable-auto-merge" },
  gl_list_issues: { route: "/api/gl-list-issues" },
  list_dir: { route: "/api/list-dir" },
  list_repo_tree: { route: "/api/list-repo-tree" },
  list_repo_dir: { route: "/api/list-repo-dir" },
  path_exists: { route: "/api/path-exists" },
  pr_files: {
    route: "/api/pr-files",
    cliPathOnly:
      "The dev-server always shells out to the `gh` CLI; the Rust command uses the REST API whenever a token is configured, so the two run different code.",
  },
  preview_cherry_pick: { route: "/api/preview-cherry-pick" },
  preview_merge: { route: "/api/preview-merge" },
  preview_rebase: { route: "/api/preview-rebase" },
  read_file: { route: "/api/read-file" },
  read_file_at_revision: { route: "/api/read-file-at-revision" },
  read_gitwandrc: { route: "/api/read-gitwandrc" },
  // The route validates the path like the Rust command and then only logs:
  // opening Finder / Explorer needs the packaged app on a desktop session, so
  // manual QA of the reveal itself happens in the Tauri app (spec §9).
  reveal_in_file_manager: { route: "/api/reveal-in-file-manager" },
  reconstruct_conflict: { route: "/api/reconstruct-conflict" },
  resolve_tree_conflict: { route: "/api/resolve-tree-conflict" },
  scan_secrets: { route: "/api/scan-secrets" },
  scratch_worktree_create: { route: "/api/scratch-worktree-create" },
  snapshot_create: { route: "/api/snapshot-create" },
  snapshot_list: { route: "/api/snapshot-list" },
  snapshot_prune: { route: "/api/snapshot-prune" },
  snapshot_restore: { route: "/api/snapshot-restore" },
  software_rendering_get_state: { route: "/api/software-rendering" },
  software_rendering_set_enabled: { route: "/api/software-rendering" },
  telemetry_get_state: { route: "/api/telemetry-state" },
  telemetry_set_enabled: { route: "/api/telemetry-state" },
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
  gh_list_reviewer_candidates: { route: "/api/gh-reviewer-candidates" },
  // One path, three methods: POST creates, PATCH edits, DELETE removes.
  gh_pr_create_comment: { route: "/api/gh-pr-comment" },
  gh_pr_delete_comment: { route: "/api/gh-pr-comment" },
  gh_pr_update_comment: { route: "/api/gh-pr-comment" },
  gh_pr_freshness_signal: { route: "/api/gh-pr-freshness" },
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
  open_url: {
    desktopOnly:
      "Hands an http(s) URL to the OS browser because the Tauri webview ignores window.open. Under dev:web the wrapper calls window.open itself, so there is nothing for a route to do.",
  },
  // The keychain is what the Gitea routes work around with an environment
  // token: a Node dev-server cannot read or write the OS credential store the
  // packaged app uses.
  delete_credential: {
    desktopOnly:
      "Deletes an entry from the OS keychain, which the Node dev-server cannot reach.",
  },
  get_credential: {
    desktopOnly:
      "Reads an entry from the OS keychain, which the Node dev-server cannot reach.",
  },
  set_credential: {
    desktopOnly:
      "Writes an entry to the OS keychain, which the Node dev-server cannot reach.",
  },

  // ─── Routes written to close a gap this audit found ───────────────────────
  // Both were fetched by backend.ts while dev-server.mjs declared neither, so
  // both 404'd under pnpm dev:web. Pinned at parity in write-failure.test.mjs.
  git_commit_template_path: { route: "/api/git-commit-template-path" },
  read_commit_template: { route: "/api/read-commit-template" },
  git_config_identity: { route: "/api/git-config-identity" },

  // ─── GAPs this audit found ────────────────────────────────────────────────
  // Nothing prevents these from having a route; they simply do not have one.
  // Listed as findings rather than dressed up as deliberate choices.
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

  // ─── GAPs in the forge wrappers (#258) ────────────────────────────────────
  // backend-pr.ts, backend-gitlab.ts, backend-gitea.ts and backend-bitbucket.ts
  // were outside the registry's scan until #258. Same reading as the block
  // above: each could have a route and does not yet.

  // ── GitHub ──
  // backend-pr.ts gives each of these a web branch that returns an empty value
  // or throws, and dev-server.mjs has no route — though the neighbouring gh-*
  // routes show the gh CLI and REST API both work from Node.
  gh_add_reaction: {
    desktopOnly:
      "GAP: no dev-server route for adding a reaction; the wrapper throws \"not supported in dev mode\".",
  },
  gh_branches: {
    desktopOnly:
      "GAP: no dev-server route for listing the remote's branches via the GitHub API; the wrapper returns an empty list.",
  },
  gh_checkout_pr: {
    desktopOnly:
      "GAP: no dev-server route for `gh pr checkout`; the wrapper throws, though Node runs the CLI as well as Rust does.",
  },
  gh_delete_reaction: {
    desktopOnly:
      "GAP: no dev-server route for removing a reaction; the wrapper throws \"not supported in dev mode\".",
  },
  gh_fork_info: {
    desktopOnly:
      "GAP: no dev-server route for fork detection; the wrapper always answers \"not a fork\", so fork-only UI never shows under dev:web.",
  },
  gh_list_reactions: {
    desktopOnly:
      "GAP: no dev-server route for listing reactions; the wrapper returns an empty list.",
  },
  gh_pr_edit: {
    desktopOnly:
      "GAP: no dev-server route for editing a PR's title or body; the wrapper throws \"requires Tauri\".",
  },
  gh_pr_ready: {
    desktopOnly:
      "GAP: no dev-server route for marking a draft PR ready; the wrapper throws \"requires Tauri\".",
  },

  // ── Azure DevOps ──
  // backend-pr.ts throws AZURE_WEB_ONLY (or returns an empty value) for every
  // one of these: there is no Azure mock in dev-server.mjs at all, unlike the
  // GitHub device flow, which has one.
  az_add_like: {
    desktopOnly:
      "GAP: no dev-server mock for liking an Azure DevOps PR comment.",
  },
  az_branches: {
    desktopOnly:
      "GAP: no dev-server mock for listing Azure DevOps branches.",
  },
  az_checkout_pr: {
    desktopOnly:
      "GAP: no dev-server mock for checking out an Azure DevOps PR locally.",
  },
  az_create_pr: {
    desktopOnly:
      "GAP: no dev-server mock for creating an Azure DevOps PR.",
  },
  az_current_user: {
    desktopOnly:
      "GAP: no dev-server mock for the signed-in Azure DevOps user.",
  },
  az_delete_like: {
    desktopOnly:
      "GAP: no dev-server mock for unliking an Azure DevOps PR comment.",
  },
  az_disable_auto_merge: {
    desktopOnly:
      "GAP: no dev-server mock for cancelling Azure DevOps auto-complete.",
  },
  az_enable_auto_merge: {
    desktopOnly:
      "GAP: no dev-server mock for setting Azure DevOps auto-complete.",
  },
  az_list_likes: {
    desktopOnly:
      "GAP: no dev-server mock for listing likes on an Azure DevOps PR comment.",
  },
  az_list_prs: {
    desktopOnly:
      "GAP: no dev-server mock for listing Azure DevOps PRs.",
  },
  az_merge_pr: {
    desktopOnly:
      "GAP: no dev-server mock for completing an Azure DevOps PR.",
  },
  az_pr_checks: {
    desktopOnly:
      "GAP: no dev-server mock for Azure DevOps PR policy and build checks.",
  },
  az_pr_comments: {
    desktopOnly:
      "GAP: no dev-server mock for Azure DevOps PR comment threads.",
  },
  az_pr_count: {
    desktopOnly:
      "GAP: no dev-server mock for counting Azure DevOps PRs.",
  },
  az_pr_create_comment: {
    desktopOnly:
      "GAP: no dev-server mock for posting an Azure DevOps PR comment.",
  },
  az_pr_detail: {
    desktopOnly:
      "GAP: no dev-server mock for Azure DevOps PR detail.",
  },
  az_pr_diff: {
    desktopOnly:
      "GAP: no dev-server mock for the Azure DevOps PR diff.",
  },
  az_pr_edit: {
    desktopOnly:
      "GAP: no dev-server mock for editing an Azure DevOps PR's title or description.",
  },
  az_pr_files: {
    desktopOnly:
      "GAP: no dev-server mock for the files an Azure DevOps PR changes.",
  },
  az_pr_ready: {
    desktopOnly:
      "GAP: no dev-server mock for publishing a draft Azure DevOps PR.",
  },
  az_pr_reviews: {
    desktopOnly:
      "GAP: no dev-server mock for Azure DevOps reviewer votes.",
  },
  az_reviewer_candidates: {
    desktopOnly:
      "GAP: no dev-server mock for Azure DevOps reviewer candidates.",
  },
  az_submit_review: {
    desktopOnly:
      "GAP: no dev-server mock for casting an Azure DevOps reviewer vote.",
  },
  azure_device_poll: {
    desktopOnly:
      "GAP: no dev-server mock for polling the Entra ID device flow, where the GitHub flow has one.",
  },
  azure_device_start: {
    desktopOnly:
      "GAP: no dev-server mock for starting the Entra ID device flow, where the GitHub flow has one.",
  },
  azure_sign_out: {
    desktopOnly:
      "GAP: no dev-server mock for Azure sign-out; the wrapper silently does nothing under dev:web.",
  },
  azure_token_present: {
    desktopOnly:
      "GAP: no dev-server mock for the Azure token check; the wrapper answers false, where GitHub has a route.",
  },

  // ── GitLab ──
  // backend-gitlab.ts returns an empty value or throws "requires Tauri" for
  // each of these, and dev-server.mjs serves no gl-* MR route beyond the two
  // auto-merge ones. `gl_merge_mr` is the case AGENTS.md § IPC cites: its
  // broken glab flag survived because nothing under dev:web ran it.
  detect_glab: {
    desktopOnly:
      "GAP: no dev-server route for detecting the glab CLI; the wrapper answers false, so GitLab UI never shows under dev:web.",
  },
  gl_add_reaction: {
    desktopOnly:
      "GAP: no dev-server mock for adding an award emoji to a GitLab MR note.",
  },
  gl_approve_mr: {
    desktopOnly:
      "GAP: no dev-server mock for approving a GitLab MR.",
  },
  gl_branches: {
    desktopOnly:
      "GAP: no dev-server mock for listing GitLab branches.",
  },
  gl_checkout_mr: {
    desktopOnly:
      "GAP: no dev-server mock for `glab mr checkout`, which Node could run as well as Rust does.",
  },
  gl_convert_draft_to_ready: {
    desktopOnly:
      "GAP: no dev-server mock for marking a draft GitLab MR ready.",
  },
  gl_create_mr: {
    desktopOnly:
      "GAP: no dev-server mock for creating a GitLab MR.",
  },
  gl_current_user: {
    desktopOnly:
      "GAP: no dev-server mock for the authenticated GitLab user.",
  },
  gl_delete_reaction: {
    desktopOnly:
      "GAP: no dev-server mock for removing an award emoji from a GitLab MR note.",
  },
  gl_get_mr: {
    desktopOnly:
      "GAP: no dev-server mock for GitLab MR detail.",
  },
  gl_list_mrs: {
    desktopOnly:
      "GAP: no dev-server mock for listing GitLab MRs.",
  },
  gl_list_reactions: {
    desktopOnly:
      "GAP: no dev-server mock for listing award emoji on a GitLab MR note.",
  },
  gl_list_reviews: {
    desktopOnly:
      "GAP: no dev-server mock for GitLab MR approvals.",
  },
  gl_merge_mr: {
    desktopOnly:
      "GAP: no dev-server mock for merging a GitLab MR — the gap that let its broken glab flag ship.",
  },
  gl_mr_annotations: {
    desktopOnly:
      "GAP: no dev-server mock for GitLab pipeline job annotations.",
  },
  gl_mr_count: {
    desktopOnly:
      "GAP: no dev-server mock for counting GitLab MRs.",
  },
  gl_mr_create_discussion: {
    desktopOnly:
      "GAP: no dev-server mock for starting an inline GitLab MR discussion.",
  },
  gl_mr_create_note: {
    desktopOnly:
      "GAP: no dev-server mock for posting a GitLab MR note.",
  },
  gl_mr_delete_note: {
    desktopOnly:
      "GAP: no dev-server mock for deleting a GitLab MR note.",
  },
  gl_mr_diff: {
    desktopOnly:
      "GAP: no dev-server mock for the GitLab MR diff.",
  },
  gl_mr_diff_refs: {
    desktopOnly:
      "GAP: no dev-server mock for a GitLab MR's base, start and head SHAs.",
  },
  gl_mr_edit: {
    desktopOnly:
      "GAP: no dev-server mock for editing a GitLab MR's title or description.",
  },
  gl_mr_files: {
    desktopOnly:
      "GAP: no dev-server mock for the files a GitLab MR changes.",
  },
  gl_mr_notes: {
    desktopOnly:
      "GAP: no dev-server mock for GitLab MR notes.",
  },
  gl_mr_pipelines: {
    desktopOnly:
      "GAP: no dev-server mock for GitLab MR pipelines.",
  },
  gl_mr_update_note: {
    desktopOnly:
      "GAP: no dev-server mock for editing a GitLab MR note.",
  },
  gl_request_reviewers: {
    desktopOnly:
      "GAP: no dev-server mock for requesting GitLab MR reviewers.",
  },
  gl_reviewer_candidates: {
    desktopOnly:
      "GAP: no dev-server mock for GitLab reviewer candidates.",
  },

  // ── Gitea / Forgejo ──
  // Only the eight reads above have routes. backend-gitea.ts labels everything
  // else "Tauri only"; the `/api/gitea-` dispatcher's env-token approach would
  // serve these as well.
  gitea_branches: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for listing branches; the wrapper returns an empty list.",
  },
  gitea_checkout_pr: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for checking out a PR locally.",
  },
  gitea_convert_draft_to_ready: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for marking a draft PR ready.",
  },
  gitea_create_comment: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for posting a PR comment.",
  },
  gitea_create_pr: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for creating a PR.",
  },
  gitea_delete_comment: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for deleting a PR comment.",
  },
  gitea_list_reviews: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for PR reviews; the wrapper returns an empty list.",
  },
  gitea_merge_pr: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for merging a PR.",
  },
  gitea_pr_edit: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for editing a PR's title or body.",
  },
  gitea_pr_files: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for the files a PR changes; the wrapper returns an empty list.",
  },
  gitea_reviewer_candidates: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for reviewer candidates; the wrapper returns an empty list.",
  },
  gitea_update_comment: {
    desktopOnly:
      "GAP: no case in the /api/gitea- dispatcher for editing a PR comment.",
  },
  gitea_validate_token: {
    desktopOnly:
      "GAP: no dev-server route for validating a Gitea token against an instance before it is stored.",
  },

  // ── Bitbucket Cloud ──
  // backend-bitbucket.ts has no web branch beyond an empty value or a "requires
  // Tauri" throw, and dev-server.mjs serves only bb-list-issues. The Gitea
  // dispatcher's environment-token pattern would carry over.
  bb_approve_pr: {
    desktopOnly:
      "GAP: no dev-server mock for approving a Bitbucket PR.",
  },
  bb_branches: {
    desktopOnly:
      "GAP: no dev-server mock for listing Bitbucket branches.",
  },
  bb_checkout_pr: {
    desktopOnly:
      "GAP: no dev-server mock for checking out a Bitbucket PR locally.",
  },
  bb_convert_draft_to_ready: {
    desktopOnly:
      "GAP: no dev-server mock for marking a draft Bitbucket PR ready.",
  },
  bb_create_comment: {
    desktopOnly:
      "GAP: no dev-server mock for posting a Bitbucket PR comment.",
  },
  bb_create_pr: {
    desktopOnly:
      "GAP: no dev-server mock for creating a Bitbucket PR.",
  },
  bb_current_user: {
    desktopOnly:
      "GAP: no dev-server mock for the authenticated Bitbucket user.",
  },
  bb_delete_comment: {
    desktopOnly:
      "GAP: no dev-server mock for deleting a Bitbucket PR comment.",
  },
  bb_get_pr: {
    desktopOnly:
      "GAP: no dev-server mock for Bitbucket PR detail.",
  },
  bb_list_prs: {
    desktopOnly:
      "GAP: no dev-server mock for listing Bitbucket PRs.",
  },
  bb_list_reviews: {
    desktopOnly:
      "GAP: no dev-server mock for Bitbucket PR approvals.",
  },
  bb_merge_pr: {
    desktopOnly:
      "GAP: no dev-server mock for merging a Bitbucket PR.",
  },
  bb_pr_annotations: {
    desktopOnly:
      "GAP: no dev-server mock for Bitbucket Code Insights annotations.",
  },
  bb_pr_ci_checks: {
    desktopOnly:
      "GAP: no dev-server mock for Bitbucket PR build statuses.",
  },
  bb_pr_comments: {
    desktopOnly:
      "GAP: no dev-server mock for Bitbucket PR comments.",
  },
  bb_pr_count: {
    desktopOnly:
      "GAP: no dev-server mock for counting Bitbucket PRs.",
  },
  bb_pr_diff: {
    desktopOnly:
      "GAP: no dev-server mock for the Bitbucket PR diff.",
  },
  bb_pr_edit: {
    desktopOnly:
      "GAP: no dev-server mock for editing a Bitbucket PR's title or description.",
  },
  bb_pr_files: {
    desktopOnly:
      "GAP: no dev-server mock for the files a Bitbucket PR changes.",
  },
  bb_reviewer_candidates: {
    desktopOnly:
      "GAP: no dev-server mock for Bitbucket reviewer candidates.",
  },
  bb_update_comment: {
    desktopOnly:
      "GAP: no dev-server mock for editing a Bitbucket PR comment.",
  },
};

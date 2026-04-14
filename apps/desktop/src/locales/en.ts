/**
 * GitWand — English locale
 *
 * Must match the exact structure of fr.ts (enforced by TypeScript).
 */
import type { Locale } from "./fr";

const en: Locale = {
  // ─── Common ─────────────────────────────────────────────
  common: {
    cancel: "Cancel",
    close: "Close",
    confirm: "Confirm",
    create: "Create",
    delete: "Delete",
    error: "Error",
    loading: "Loading\u2026",
    no: "No",
    ok: "OK",
    open: "Open",
    optional: "optional",
    refresh: "Refresh",
    save: "Save",
    ctrlEnter: "Ctrl+Enter to confirm",
    yes: "Yes",
  },

  // ─── App header ─────────────────────────────────────────
  header: {
    title: "GitWand",
    modeRepo: "Repo",
    modeMerge: "Merge",
    open: "Open",
    openFolder: "Open a folder",
    resolveAll: "Resolve all",
    save: "Save",
    saveShortcut: "Save (Ctrl+S)",
    undo: "Undo (Ctrl+Z)",
    redo: "Redo (Ctrl+Shift+Z)",
    themeLight: "Switch to light mode",
    themeDark: "Switch to dark mode",
    themeLightLabel: "Light mode",
    themeDarkLabel: "Dark mode",
    push: "Push",
    pull: "Pull",
    sync: "Sync",
    syncTooltip: "Fetch remote branches and pull",
    merge: "Merge",
    mergeTooltip: "Merge a branch into the current branch",
    mergeFilterPlaceholder: "Branch to merge\u2026",
    // Stats
    file: "file",
    files: "files",
    conflict: "conflict",
    conflicts: "conflicts",
    auto: "auto",
    remaining: "remaining",
    remainingPlural: "remaining",
    staged: "staged",
    modified: "modified",
    untracked: "untracked",
    // Toast notifications
    syncUpToDate: "Already up to date",
    syncDone: "Sync completed",
    pushDone: "Push completed",
    mergeDone: "Merge completed",
    mergeAborted: "Merge aborted",
    resolveConflicts: "resolve conflicts to continue",
    abortMerge: "Abort merge",
  },

  // ─── Sidebar / RepoSidebar ──────────────────────────────
  sidebar: {
    tabChanges: "Changes",
    tabBranches: "Branches",
    tabLog: "Log",
    tabGraph: "Graph",
    // Sections
    sectionConflicts: "Conflicts",
    sectionStaged: "Staged",
    sectionModified: "Modified",
    sectionUntracked: "Untracked",
    // Actions
    stageAll: "Stage all",
    unstageAll: "Unstage all",
    stage: "Stage",
    unstage: "Unstage",
    // Commit panel
    stageAllButton: "Stage all ({0})",
    summaryPlaceholder: "Summary (required)",
    descriptionPlaceholder: "Description (optional)",
    commitButton: "Commit ({0})",
    commitButtonLoading: "Committing\u2026",
    commitHint: "Ctrl+Enter to commit",
    // Empty
    cleanTree: "Working tree clean",
  },

  // ─── FileList (merge mode) ──────────────────────────────
  fileList: {
    title: "Files",
    noConflict: "No conflicts",
    autoResolvable: "{0} auto-resolvable",
    autoResolvablePlural: "{0} auto-resolvable",
    autoPartial: "{0}/{1} auto",
    conflictCount: "{0} conflict",
    conflictCountPlural: "{0} conflicts",
  },

  // ─── DiffViewer ─────────────────────────────────────────
  diff: {
    noDiff: "No diff available for this file",
    noDiffHint: "New or binary file",
    selectFile: "Select a file to view the diff",
    modeInline: "Inline",
    modeSideBySide: "Side by side",
    collapsedLines: "{0} hidden lines",
    prevHunk: "Previous change",
    nextHunk: "Next change",
    fileHistory: "File history",
    openInEditor: "Open in external editor",
    compare: "Compare",
    compareHint: "Select two commits to compare versions",
    compareFrom: "{0} selected — pick the second commit",
    compareSelect: "Select for comparison",
    compareEmpty: "Select two commits to compare",
    compareGoLog: "Go to log",
    stageHunk: "Stage hunk",
    stageSelected: "Stage ({0})",
    selectHunk: "Select hunk",
  },

  // ─── CommitLog ──────────────────────────────────────────
  log: {
    title: "History",
    noCommit: "No commits",
    selectCommit: "Select a commit to view changes",
    noDiffForCommit: "No diff for this commit",
    unpushedOne: "unpushed commit",
    unpushedMany: "unpushed commits",
    pushed: "Pushed to remote",
    editMessage: "Edit commit message",
    amendConfirm: "Amend commit",
  },
  commit: {
    summary: "Summary",
    summaryPlaceholder: "Summary (required)",
    description: "Description",
    descriptionPlaceholder: "Description (optional)",
  },

  // ─── Relative dates ─────────────────────────────────────
  date: {
    now: "just now",
    minutesAgo: "{0}m ago",
    hoursAgo: "{0}h ago",
    daysAgo: "{0}d ago",
    weeksAgo: "{0}w ago",
  },

  // ─── Branches ───────────────────────────────────────────
  branches: {
    title: "Branches",
    local: "Local",
    remote: "Remote",
    create: "New branch",
    namePlaceholder: "Branch name\u2026",
    filter: "Filter\u2026",
    switch: "Switch",
    deleteLabel: "Delete",
    noBranch: "No branches found",
    previewMerge: "Preview merge",
  },

  // ─── Merge Preview (Phase 8.1) ──────────────────────────
  mergePreview: {
    analyzing: "Analyzing\u2026",
    noConflicts: "Clean merge",
    fullyAuto: "100\u00a0% auto-resolvable",
    needsReview: "Conflicts to review",
    conflicting: "conflicting file(s)",
    autoResolved: "auto-resolvable",
    manual: "manual",
    clean: "clean",
    conflictsAutoResolved: "conflict(s) auto-resolved",
    partial: "auto-resolved",
    addDelete: "add/delete",
    conflictsManual: "manual conflict(s)",
  },

  // ─── EmptyState ─────────────────────────────────────────
  empty: {
    title: "No repository open",
    subtitle: "Select a Git repository to get started",
    openButton: "Open a repository",
    shortcut: "to open quickly",
    recentTitle: "Recent",
  },

  // ─── FolderPicker ───────────────────────────────────────
  folderPicker: {
    title: "Open a folder",
    recentTitle: "Recent & Favorites",
    pathPlaceholder: "Folder path\u2026",
    go: "Go",
    parentDir: "Parent folder",
    pin: "Pin",
    unpin: "Unpin",
    remove: "Remove from history",
    gitRepo: "Git repository",
  },

  // ─── MergeEditor ────────────────────────────────────────
  merge: {
    conflictType: "conflict",
    acceptCurrent: "Accept Current Change",
    acceptIncoming: "Accept Incoming Change",
    acceptBoth: "Accept Both Changes",
    customEdit: "Edit",
    currentBranch: "Current branch",
    incomingBranch: "Incoming branch",
    resolveAuto: "Resolve auto",
    resolveAutoLabel: "Automatically resolve conflicts",
    recommended: "recommended",
    autoResolved: "auto",
    resolvedManually: "Manually resolved",
    analysing: "Analysing conflicts\u2026",
    loadingRepo: "Loading repository\u2026",
    successTitle: "Merge completed successfully",
    successDesc: "All conflicts have been resolved and the merge commit has been created.",
    successClose: "Close",
    successPush: "Push",
  },

  // ─── Settings ───────────────────────────────────────────
  settings: {
    title: "Settings",
    language: "Language",
    languageAuto: "Automatic (system)",
    theme: "Theme",
    themeDark: "Dark",
    themeLight: "Light",
    themeSystem: "System",
    editor: "External editor",
    editorPlaceholder: "e.g. code, vim, nano",
    gitPath: "Git path",
    gitPathAuto: "Automatic",
    defaultBranch: "Default branch",
    commitSignature: "Add \u201c\u{1FA84} Commit via GitWand\u201d to description",
    commitSignatureHint: "A small signature added automatically \u2014 removable anytime",
    diffDisplay: "Diff display",
    diffInline: "Inline (unified)",
    diffSideBySide: "Side by side",
    pullMode: "Pull mode",
    pullMerge: "Merge (default)",
    pullRebase: "Rebase",
    switchBehavior: "Switch behavior",
    switchStash: "Auto stash",
    switchAsk: "Ask",
    switchRefuse: "Refuse if dirty",
    fontSize: "Font size",
    tabSize: "Tab size",
    spaces: "spaces",
    notifications: "Notifications",
    notificationsHint: "Show toast notifications (sync, push, errors)",
  },
} as const;

export default en;

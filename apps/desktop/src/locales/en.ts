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
    refresh: "Refresh",
    save: "Save",
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
  },

  // ─── Sidebar / RepoSidebar ──────────────────────────────
  sidebar: {
    tabChanges: "Changes",
    tabBranches: "Branches",
    tabLog: "Log",
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
    commitPlaceholder: "Commit message\u2026",
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
  },

  // ─── CommitLog ──────────────────────────────────────────
  log: {
    title: "History",
    noCommit: "No commits",
    selectCommit: "Select a commit to view changes",
    noDiffForCommit: "No diff for this commit",
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
  },

  // ─── EmptyState ─────────────────────────────────────────
  empty: {
    title: "No files loaded",
    subtitle: "Open a folder containing a Git repository",
    openButton: "Open a folder",
    shortcut: "Ctrl+K",
    recentTitle: "Recent folders",
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
    conflictType: "Conflict type",
    keepOurs: "Keep Ours",
    keepTheirs: "Keep Theirs",
    keepBoth: "Keep both",
    customEdit: "Edit manually",
    autoResolved: "Auto-resolved",
    resolvedManually: "Manually resolved",
    analysing: "Analysing conflicts\u2026",
    loadingRepo: "Loading repository\u2026",
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
  },
} as const;

export default en;

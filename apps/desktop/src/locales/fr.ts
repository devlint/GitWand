/**
 * GitWand — French locale (default)
 *
 * Convention:
 *   - Keys are grouped by component / feature area
 *   - Use {0}, {1}, ... for positional interpolation
 *   - Use {count} for pluralization helpers
 *   - Keep alphabetical order inside each group
 */
const fr = {
  // ─── Common ─────────────────────────────────────────────
  common: {
    cancel: "Annuler",
    close: "Fermer",
    confirm: "Confirmer",
    create: "Cr\u00e9er",
    delete: "Supprimer",
    error: "Erreur",
    loading: "Chargement\u2026",
    no: "Non",
    ok: "OK",
    open: "Ouvrir",
    refresh: "Rafra\u00eechir",
    save: "Sauvegarder",
    yes: "Oui",
  },

  // ─── App header ─────────────────────────────────────────
  header: {
    title: "GitWand",
    modeRepo: "Repo",
    modeMerge: "Merge",
    open: "Ouvrir",
    openFolder: "Ouvrir un dossier",
    resolveAll: "Tout r\u00e9soudre",
    save: "Sauvegarder",
    saveShortcut: "Sauvegarder (Ctrl+S)",
    undo: "Annuler (Ctrl+Z)",
    redo: "R\u00e9tablir (Ctrl+Shift+Z)",
    themeLight: "Passer en mode clair",
    themeDark: "Passer en mode sombre",
    themeLightLabel: "Mode clair",
    themeDarkLabel: "Mode sombre",
    push: "Push",
    pull: "Pull",
    // Stats
    file: "fichier",
    files: "fichiers",
    conflict: "conflit",
    conflicts: "conflits",
    auto: "auto",
    remaining: "restant",
    remainingPlural: "restants",
    staged: "staged",
    modified: "modifi\u00e9s",
    untracked: "non suivis",
  },

  // ─── Sidebar / RepoSidebar ──────────────────────────────
  sidebar: {
    tabChanges: "Changements",
    tabBranches: "Branches",
    tabLog: "Log",
    // Sections
    sectionConflicts: "Conflits",
    sectionStaged: "Staged",
    sectionModified: "Modifi\u00e9s",
    sectionUntracked: "Non suivis",
    // Actions
    stageAll: "Tout stager",
    unstageAll: "Tout unstager",
    stage: "Stager",
    unstage: "Unstager",
    // Commit panel
    commitPlaceholder: "Message du commit\u2026",
    commitButton: "Commit ({0})",
    commitButtonLoading: "Commit\u2026",
    commitHint: "Ctrl+Enter pour commiter",
    // Empty
    cleanTree: "Working tree clean",
  },

  // ─── FileList (merge mode) ──────────────────────────────
  fileList: {
    title: "Fichiers",
    noConflict: "Aucun conflit",
    autoResolvable: "{0} auto-r\u00e9solvable",
    autoResolvablePlural: "{0} auto-r\u00e9solvables",
    autoPartial: "{0}/{1} auto",
    conflictCount: "{0} conflit",
    conflictCountPlural: "{0} conflits",
  },

  // ─── DiffViewer ─────────────────────────────────────────
  diff: {
    noDiff: "Pas de diff disponible pour ce fichier",
    noDiffHint: "Fichier nouveau ou binaire",
    selectFile: "S\u00e9lectionnez un fichier pour voir le diff",
  },

  // ─── CommitLog ──────────────────────────────────────────
  log: {
    title: "Historique",
    noCommit: "Aucun commit",
    selectCommit: "S\u00e9lectionnez un commit pour voir les changements",
    noDiffForCommit: "Pas de diff pour ce commit",
    unpushedOne: "commit non push\u00e9",
    unpushedMany: "commits non push\u00e9s",
    pushed: "Push\u00e9s sur le remote",
  },

  // ─── Relative dates ─────────────────────────────────────
  date: {
    now: "maintenant",
    minutesAgo: "il y a {0} min",
    hoursAgo: "il y a {0}h",
    daysAgo: "il y a {0}j",
    weeksAgo: "il y a {0} sem.",
  },

  // ─── Branches ───────────────────────────────────────────
  branches: {
    title: "Branches",
    local: "Locales",
    remote: "Remotes",
    create: "Nouvelle branche",
    namePlaceholder: "Nom de la branche\u2026",
    filter: "Filtrer\u2026",
    switch: "Basculer",
    deleteLabel: "Supprimer",
    noBranch: "Aucune branche trouv\u00e9e",
  },

  // ─── EmptyState ─────────────────────────────────────────
  empty: {
    title: "Aucun fichier charg\u00e9",
    subtitle: "Ouvrez un dossier contenant un d\u00e9p\u00f4t Git",
    openButton: "Ouvrir un dossier",
    shortcut: "Ctrl+K",
    recentTitle: "Dossiers r\u00e9cents",
  },

  // ─── FolderPicker ───────────────────────────────────────
  folderPicker: {
    title: "Ouvrir un dossier",
    recentTitle: "R\u00e9cents & Favoris",
    pathPlaceholder: "Chemin du dossier\u2026",
    go: "Aller",
    parentDir: "Dossier parent",
    pin: "\u00c9pingler",
    unpin: "D\u00e9s\u00e9pingler",
    remove: "Retirer de l\u2019historique",
    gitRepo: "D\u00e9p\u00f4t Git",
  },

  // ─── MergeEditor ────────────────────────────────────────
  merge: {
    conflictType: "Type de conflit",
    keepOurs: "Garder Ours",
    keepTheirs: "Garder Theirs",
    keepBoth: "Garder les deux",
    customEdit: "\u00c9diter manuellement",
    autoResolved: "Auto-r\u00e9solu",
    resolvedManually: "R\u00e9solu manuellement",
    analysing: "Analyse des conflits\u2026",
    loadingRepo: "Chargement du repo\u2026",
  },

  // ─── Settings ───────────────────────────────────────────
  settings: {
    title: "Param\u00e8tres",
    language: "Langue",
    languageAuto: "Automatique (syst\u00e8me)",
    theme: "Th\u00e8me",
    themeDark: "Sombre",
    themeLight: "Clair",
    themeSystem: "Syst\u00e8me",
    editor: "\u00c9diteur externe",
    editorPlaceholder: "ex: code, vim, nano",
    gitPath: "Chemin de Git",
    gitPathAuto: "Automatique",
    defaultBranch: "Branche par d\u00e9faut",
  },
} as const;

// Widen literal string types to plain `string` for locale compatibility
type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};

/** The shape of a locale: same structure as fr, but with `string` values. */
export type Locale = Widen<typeof fr>;

/** All possible dotted keys: "header.open", "sidebar.tabChanges", etc. */
export type LocaleKey = FlatKeys<typeof fr>;

// Utility: flatten nested keys
type FlatKeys<T, Prefix extends string = ""> = T extends Record<string, unknown>
  ? {
      [K in keyof T & string]: T[K] extends Record<string, unknown>
        ? FlatKeys<T[K], `${Prefix}${K}.`>
        : `${Prefix}${K}`;
    }[keyof T & string]
  : never;

export default fr;

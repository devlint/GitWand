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
    optional: "optionnel",
    refresh: "Rafra\u00eechir",
    save: "Sauvegarder",
    ctrlEnter: "Ctrl+Entr\u00e9e pour valider",
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
    publish: "Publier",
    publishTooltip: "Publier la branche sur origin (git push --set-upstream)",
    pull: "Pull",
    sync: "Sync",
    syncTooltip: "Récupérer les branches distantes et pull",
    merge: "Merge",
    mergeTooltip: "Merger une branche dans la branche courante",
    mergeFilterPlaceholder: "Branche à merger\u2026",
    // Stats
    file: "fichier",
    files: "fichiers",
    conflict: "conflit",
    conflicts: "conflits",
    auto: "auto",
    remaining: "restant",
    remainingPlural: "restants",
    staged: "indexés",
    modified: "modifi\u00e9s",
    untracked: "non suivis",
    // Toast notifications
    syncUpToDate: "D\u00e9j\u00e0 \u00e0 jour",
    syncDone: "Synchronisation termin\u00e9e",
    pushDone: "Push termin\u00e9",
    mergeDone: "Merge termin\u00e9",
    mergeAborted: "Merge annul\u00e9",
    resolveConflicts: "r\u00e9solvez les conflits pour continuer",
    abortMerge: "Annuler le merge",
  },

  // ─── Sidebar / RepoSidebar ──────────────────────────────
  sidebar: {
    tabChanges: "Changements",
    tabBranches: "Branches",
    tabLog: "Log",
    tabGraph: "Graphe",
    // Log scope toggle (current branch vs all refs)
    logScopeLabel: "Portée du log",
    logScopeCurrent: "Branche courante",
    logScopeCurrentTitle: "Afficher uniquement les commits de la branche « {0} »",
    logScopeAll: "Toutes les branches",
    logScopeAllTitle: "Afficher les commits de toutes les branches",
    // Sections
    sectionConflicts: "Conflits",
    sectionStaged: "Indexés",
    sectionModified: "Modifi\u00e9s",
    sectionUntracked: "Non suivis",
    // Actions
    stageAll: "Tout indexer",
    unstageAll: "Tout désindexer",
    stage: "Indexer",
    unstage: "Désindexer",
    // Commit panel
    stageAllButton: "Tout ajouter ({0})",
    summaryPlaceholder: "Résumé (requis)",
    descriptionPlaceholder: "Description (optionnel)",
    commitButton: "Commiter ({0})",
    commitButtonLoading: "En cours\u2026",
    commitHint: "Ctrl+Enter pour valider",
    // Empty
    cleanTree: "Espace de travail propre",
    // Dashboard-specific sidebar blocks
    pinnedBranches: "Branches épinglées",
    noBranches: "Aucune branche",
    recentActivity: "Activité récente",
    quickActions: "Actions rapides",
  },

  // ─── Dashboard ──────────────────────────────────────────
  dashboard: {
    loading: "Chargement du tableau de bord\u2026",
    // Hero
    repoState: "État du dépôt",
    stateClean: "Tout est propre",
    stateDirty: "{0} changement(s) en attente",
    stateAhead: "Prêt à pousser — {0} commit(s) en avance",
    stateBehind: "Synchronisation requise — {0} commit(s) en retard",
    stateConflicts: "Conflits à résoudre",
    stateVsRemote: "Par rapport à origin/{0}",
    stateOnBranch: "Sur la branche {0}",
    chipNoConflict: "Aucun conflit",
    chipConflicts: "{0} conflit(s)",
    chipAhead: "{0} en avance",
    chipBehind: "{0} en retard",
    chipClean: "propre",
    healthTitle: "Santé du dépôt",
    healthExcellent: "Excellente",
    healthGood: "Bonne",
    healthFair: "Correcte",
    healthPoor: "À améliorer",
    nextStep: "Prochaine étape",
    nextResolveConflicts: "Résoudre les {0} conflit(s)",
    nextCommit: "Commiter les {0} changement(s)",
    nextPush: "Pousser {0} commit(s)",
    nextPublish: "Publier la branche sur origin",
    nextSync: "Synchroniser ({0} en retard)",
    nextReviewPrs: "Reviewer les {0} PR ouverte(s)",
    nextAllCaughtUp: "Tout est à jour — explorer l'historique",
    openAction: "Ouvrir",
    lastActivity: "Dernière activité",
    // Metrics
    metricCommits: "Commits (7j)",
    metricBranches: "Branches",
    metricContributors: "Contributeurs",
    metricChanges: "Changements",
    metricFiles: "Fichiers suivis",
    metricPrs: "PRs ouvertes",
    prsMergedThisWeek: "{0} mergée(s) cette semaine",
    staged: "indexé(s)",
    modified: "modifié(s)",
    new: "nouveau(x)",
    // Heatmap
    heatmapTitle: "Activité des 6 derniers mois",
    viewAll: "Voir tout",
    less: "Moins",
    more: "Plus",
    dayMon: "Lun",
    dayWed: "Mer",
    dayFri: "Ven",
    // Contributors / commit types
    contributorsTitle: "Contributeurs",
    noContributors: "Aucun contributeur",
    commitTypes: "Répartition par type",
    // Commits + chart
    recentCommits: "Commits récents",
    noCommits: "Aucun commit",
    chartTitle: "Commits par jour (14j)",
    // README
    formatted: "Formaté",
    raw: "Brut",
    noReadme: "Aucun README.md trouvé dans ce dépôt",
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
    modeInline: "Inline",
    modeSideBySide: "Côte à côte",
    collapsedLines: "{0} lignes masquées",
    prevHunk: "Changement précédent",
    nextHunk: "Changement suivant",
    fileHistory: "Historique du fichier",
    openInEditor: "Ouvrir dans l'éditeur externe",
    compare: "Comparer",
    compareHint: "Sélectionnez deux commits pour comparer les versions",
    compareFrom: "{0} sélectionné — choisissez le second commit",
    compareSelect: "Sélectionner pour comparaison",
    compareEmpty: "Sélectionnez deux commits pour comparer",
    compareGoLog: "Aller au log",
    stageHunk: "Indexer ce bloc",
    stageSelected: "Indexer ({0})",
    selectHunk: "Sélectionner le bloc",
  },

  // ─── CommitLog ──────────────────────────────────────────
  log: {
    title: "Historique",
    noCommit: "Aucun commit",
    selectCommit: "S\u00e9lectionnez un commit pour voir les changements",
    noDiffForCommit: "Pas de diff pour ce commit",
    unpushedOne: "commit non push\u00e9",
    unpushedMany: "commits non push\u00e9s",
    unpublishedBranch: "Branche non publi\u00e9e",
    unpublishedBadge: "non publi\u00e9",
    pushed: "Push\u00e9s sur le remote",
    editMessage: "Modifier le message de commit",
    amendConfirm: "Modifier le commit",
  },
  commit: {
    summary: "R\u00e9sum\u00e9",
    summaryPlaceholder: "R\u00e9sum\u00e9 (requis)",
    description: "Description",
    descriptionPlaceholder: "Description (optionnel)",
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
    previewMerge: "Aperçu du merge",
  },

  // ─── Merge Preview (Phase 8.1) ──────────────────────────
  mergePreview: {
    analyzing: "Analyse en cours\u2026",
    noConflicts: "Merge propre",
    fullyAuto: "100\u00a0% auto-résolvable",
    needsReview: "Conflits à résoudre",
    conflicting: "fichier(s) en conflit",
    autoResolved: "auto-résolvable(s)",
    manual: "manuel(s)",
    clean: "propre(s)",
    conflictsAutoResolved: "conflit(s) auto-résolu(s)",
    partial: "auto-résolu(s)",
    addDelete: "ajout/suppression",
    conflictsManual: "conflit(s) manuel(s)",
  },

  // ─── EmptyState ─────────────────────────────────────────
  empty: {
    title: "Aucun d\u00e9p\u00f4t ouvert",
    subtitle: "S\u00e9lectionnez un d\u00e9p\u00f4t Git pour commencer",
    openButton: "Ouvrir un d\u00e9p\u00f4t",
    shortcut: "pour ouvrir rapidement",
    recentTitle: "R\u00e9cents",
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
    conflictType: "conflit",
    acceptCurrent: "Accepter version courante",
    acceptIncoming: "Accepter version entrante",
    acceptBoth: "Accepter les deux",
    customEdit: "\u00c9diter",
    currentBranch: "Branche courante",
    incomingBranch: "Branche entrante",
    resolveAuto: "R\u00e9soudre auto",
    resolveAutoLabel: "R\u00e9soudre automatiquement les conflits",
    recommended: "recommand\u00e9",
    autoResolved: "auto",
    resolvedManually: "R\u00e9solu manuellement",
    analysing: "Analyse des conflits\u2026",
    loadingRepo: "Chargement du repo\u2026",
    successTitle: "Merge terminé avec succès",
    successDesc: "Tous les conflits ont été résolus et le merge commit a été créé.",
    successClose: "Fermer",
    successPush: "Push",
  },

  // ─── PR creation ────────────────────────────────────────
  pr: {
    create: {
      title: "Nouvelle pull request",
      subtitle: "Ouvre une PR pour proposer tes changements à la review. Remplis le titre, choisis la branche cible, et ajoute une description.",
      branchesLabel: "Branches",
      fromLabel: "Depuis",
      intoLabel: "Vers",
      branchesHint: "Les commits présents dans la branche de gauche mais pas dans la branche cible seront inclus dans la PR.",
      sameBranchWarn: "La branche cible doit être différente de la branche courante.",
      titleLabel: "Titre",
      titlePlaceholder: "Court, explicite, à l'impératif (ex : « Fix: éviter le double-render du loader »)",
      titleHint: "Un bon titre tient en moins de 72 caractères et décrit le « quoi » — le « pourquoi » va dans la description.",
      bodyLabel: "Description",
      bodyPlaceholder: "Explique le contexte, les changements, et comment tester. Markdown supporté.",
      bodyHint: "Astuce : utilise les templates ci-dessus pour démarrer rapidement.",
      templateLabel: "Template :",
      draftLabel: "Ouvrir en draft",
      draftHint: "Une PR draft ne peut pas être mergée et n'envoie pas de notifications aux reviewers. Utile pour un WIP.",
      submit: "Créer la pull request",
      submitDraft: "Créer en draft",
      submitting: "Création\u2026",
      replaceBodyConfirm: "Remplacer le texte existant par ce template ?",
      // RTE
      tabWrite: "Écrire",
      tabPreview: "Aperçu",
      previewEmpty: "Rien à prévisualiser\u2026",
      mdBold: "Gras (Ctrl+B)",
      mdItalic: "Italique (Ctrl+I)",
      mdCode: "Code inline",
      mdCodeBlock: "Bloc de code",
      mdH1: "Titre 1",
      mdH2: "Titre 2",
      mdH3: "Titre 3",
      mdUl: "Liste à puces",
      mdOl: "Liste numérotée",
      mdQuote: "Citation",
      mdLink: "Lien",
      // Template modal
      templateModalTitle: "Remplacer la description ?",
      templateModalDesc: "La description actuelle sera remplacée par le template « {0} ». Cette action ne peut pas être annulée.",
      templateModalConfirm: "Remplacer",
      // Reviewers
      reviewersLabel: "Reviewers",
      reviewersPlaceholder: "Ajouter un reviewer (username GitHub ou org/team)\u2026",
      reviewersHint: "Tape un nom puis Entrée, espace ou virgule. Utilise org/team-slug pour une équipe. Les reviewers recevront une notification à la création.",
    },
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
    commitSignature: "Ajouter \u00ab \u{1FA84} Commit via GitWand \u00bb dans la description",
    commitSignatureHint: "Un petit clin d\u2019\u0153il ajout\u00e9 automatiquement \u2014 supprimable \u00e0 tout moment",
    diffDisplay: "Affichage des diffs",
    diffInline: "Inline (unifi\u00e9)",
    diffSideBySide: "C\u00f4te \u00e0 c\u00f4te",
    pullMode: "Mode de pull",
    pullMerge: "Merge (d\u00e9faut)",
    pullRebase: "Rebase",
    switchBehavior: "Comportement au switch",
    switchStash: "Stash automatique",
    switchAsk: "Demander",
    switchRefuse: "Refuser si modifi\u00e9",
    fontSize: "Taille de police",
    tabSize: "Indentation (tab)",
    spaces: "espaces",
    notifications: "Notifications",
    notificationsHint: "Afficher les notifications toast (sync, push, erreurs)",
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

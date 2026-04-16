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
    tabStash: "Stash",
    stashTitle: "Gestionnaire de stash",
    // Log scope toggle (current branch vs all refs)
    logScopeLabel: "Portée du log",
    logScopeCurrent: "Branche courante",
    logScopeCurrentTitle: "Afficher uniquement les commits de la branche « {0} »",
    logScopeAll: "Toutes les branches",
    logScopeAllTitle: "Afficher les commits de toutes les branches",
    logAuthorMine: "Mes commits",
    logAuthorMineTitle: "Afficher uniquement mes commits",
    logAuthorAllTitle: "Filtrer par auteur — cliquer pour afficher uniquement mes commits",
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
    aiGenerateTooltip: "Générer un message avec l'IA",
    aiGeneratingTooltip: "Génération en cours\u2026",
    aiRegenerate: "Régénérer",
    aiShorten: "Raccourcir",
    aiDetail: "Détailler",
    aiChangeLang: "Changer de langue",
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
    searchPlaceholder: "Filtrer (sujet, auteur, hash\u2026) \u2014 Entr\u00e9e pour une recherche IA",
    searchAiHint: "Recherche IA : tape une question en langage naturel puis Entr\u00e9e ou ✨",
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
    aiHint: "Sugg\u00e9rer un nom via l'IA (depuis ta description ou le diff courant)",
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

  // ─── Interactive Rebase (Phase 1.2.1) ──────────────────
  rebase: {
    title: "Rebase interactif",
    button: "Rebase",
    baseLabel: "Branche cible",
    baseHint: "S\u00e9lectionnez la branche sur laquelle rebaser vos commits.",
    basePlaceholder: "Filtrer les branches\u2026",
    commitsLabel: "Commits \u00e0 rebaser",
    commitsHint: "Glissez pour r\u00e9ordonner, cliquez sur l\u2019action pour la changer. Double-clic sur le message pour le modifier.",
    changeBase: "Changer la base",
    cycleAction: "Changer l\u2019action (clic)",
    dragHint: "Glisser pour d\u00e9placer",
    start: "Lancer le rebase",
    running: "Rebase en cours\u2026",
    inProgress: "Rebase en cours",
    conflict: "Conflit",
    continue: "Continuer",
    abort: "Annuler",
    skip: "Passer",
    reword: "Modifier le message",
    drop: "Supprimer",
    restore: "Restaurer",
    done: "Rebase termin\u00e9",
    aiSquashSuggest: "Sugg\u00e9rer un squash",
    aiSquashHint: "Analyse les commits pour proposer des groupes \u00e0 squasher par intention.",
    aiSquashApplying: "Analyse\u2026",
    aiSquashApply: "Appliquer",
  },

  // ─── EmptyState ─────────────────────────────────────────
  empty: {
    title: "Aucun d\u00e9p\u00f4t ouvert",
    subtitle: "S\u00e9lectionnez un d\u00e9p\u00f4t Git pour commencer",
    openButton: "Ouvrir un d\u00e9p\u00f4t",
    shortcut: "pour ouvrir rapidement",
    recentTitle: "R\u00e9cents",
    tipLabel: "Le saviez-vous ?",
    tips: [
      "GitWand r\u00e9sout automatiquement les conflits triviaux : whitespace, m\u00eame modification des deux c\u00f4t\u00e9s, \u00e9ditions sur zones disjointes, suppression vs inchang\u00e9\u2026",
      "Le merge editor style VS Code propose des actions inline \u00abAccepter courant / entrant / les deux / \u00c9diter\u00bb, avec un badge \u00abRecommand\u00e9\u00bb si le scoring de confiance est lev\u00e9.",
      "Avant de merger, clique sur l\u2019ic\u00f4ne de preview \u00e0 c\u00f4t\u00e9 d\u2019une branche : GitWand simule le merge sans toucher au working tree et te dit ce qui est auto-r\u00e9solvable.",
      "Le serveur MCP (@gitwand/mcp) expose 5 outils aux agents IA (Claude Code, Cursor, Windsurf\u2026). GitWand r\u00e9sout le trivial, l\u2019agent s\u2019occupe des cas complexes.",
      "Rebase interactif : drag-and-drop pour r\u00e9ordonner les commits, multi-s\u00e9lection pour squasher, gestion des conflits en cours (continue / abort / skip) int\u00e9gr\u00e9e.",
      "Absorb : clic droit sur un fichier modifi\u00e9 \u2192 \u00abAbsorber dans un commit\u00bb. GitWand d\u00e9tecte le commit candidat via git blame.",
      "G\u00e9n\u00e8re tes messages de commit avec l\u2019IA : clique sur la baguette dans la zone de commit, avec Claude Code CLI tu utilises ton abonnement Max/Pro sans cl\u00e9 API.",
      "Les conflits que GitWand ne r\u00e9sout pas viennent avec un DecisionTrace : tu vois exactement pourquoi chaque pattern a \u00e9t\u00e9 rejet\u00e9. Clique sur \u00abExpliquer\u00bb pour une version en langage naturel.",
      "Undo universel : chaque op\u00e9ration GitWand (commit, merge, rebase, cherry-pick, stash, discard) va dans un stack. Un clic pour revenir en arri\u00e8re via git reset / reflog.",
      "Cmd/Ctrl+T ouvre un nouvel onglet pour un autre repo. Cmd/Ctrl+1\u20269 change d\u2019onglet. Cmd/Ctrl+W ferme l\u2019onglet courant.",
      "Le raccourci global Cmd+Shift+G (ou Ctrl+Shift+G) r\u00e9veille GitWand depuis n\u2019importe quelle app.",
      "Stash intelligent : laisse l\u2019IA g\u00e9n\u00e9rer un message depuis ton diff courant. Tu retrouveras tes stashes avec un label lisible dans git stash list.",
      "GitHub PR workflow int\u00e9gr\u00e9 via gh : liste des PRs, review inline avec commentaires multi-lignes, Approve / Request changes / Comment, tout depuis GitWand.",
      "Le panneau Intelligence pr\u00e9dit les conflits d\u2019une branche avant de merger, identifie les hotspots, et propose des suggestions IA par hunk.",
      "File history + blame + time-travel diff : clique sur un fichier dans l\u2019historique pour voyager dans le temps, ligne par ligne.",
      "Politiques de merge configurables par projet via .gitwandrc : prefer-ours, prefer-theirs, prefer-safety, strict\u2026 avec des r\u00e8gles par glob.",
      "Terminal Git int\u00e9gr\u00e9 avec autocomplete des branches et tags \u2014 pas besoin de quitter GitWand pour une commande rare.",
    ],
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
      reviewersLoading: "Chargement des reviewers\u2026",
      // AI
      aiGenerate: "G\u00e9n\u00e9rer avec l'IA",
      aiGenerating: "G\u00e9n\u00e9ration\u2026",
      aiHint: "Analyse les commits entre les deux branches pour proposer un titre et une description.",
      aiReplaceConfirm: "Le titre et la description actuels seront remplac\u00e9s. Continuer ?",
    },
  },

  // ─── Settings ───────────────────────────────────────────
  settings: {
    title: "Param\u00e8tres",
    language: "Langue de l\u2019interface",
    languageAuto: "Automatique (syst\u00e8me)",
    commitMessageLang: "Langue des messages de commit",
    commitMessageLangAuto: "Suivre la langue de l\u2019interface",
    commitMessageLangHint: "Langue utilis\u00e9e par l\u2019IA pour g\u00e9n\u00e9rer les messages de commit",
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

  // ─── Undo ───────────────────────────────────────────────
  undoStack: {
    title: "Historique des opérations",
    undoButton: "Rembobiner",
    undoTooltip: "Rembobiner la dernière opération Git",
    noHistory: "Aucune opération récente",
    undone: "Opération annulée",
    undoConfirm: "Annuler cette opération ? Les changements seront restaurés.",
    undoHardConfirm: "Annuler cette opération ? ⚠️ Les modifications non committées seront perdues.",
    // Operation types
    opCommit: "Commit",
    opAmend: "Amend",
    opMerge: "Merge",
    opCherryPick: "Cherry-pick",
    opRebase: "Rebase",
    opPull: "Pull",
    opReset: "Reset",
    opCheckout: "Checkout",
    opStash: "Stash",
    opOther: "Opération",
  },

  // ─── Absorb ─────────────────────────────────────────────
  absorb: {
    action: "Absorber",
    tooltip: "Absorber dans le commit d'origine",
    analyzing: "Analyse en cours\u2026",
    absorbing: "Absorption en cours\u2026",
    noCandidate: "Aucun commit cible trouv\u00e9 — les modifications touchent plusieurs commits",
    candidate: "Absorber dans {0}",
    candidateHint: "{0} hunk(s) \u2192 {1}",
    done: "Modifications absorb\u00e9es dans {0}",
    confirmTitle: "Absorber dans ce commit ?",
    confirmDesc: "Les modifications de {0} seront int\u00e9gr\u00e9es dans le commit {1}.",
    lines: "Lignes {0}",
    aiRanked: "\u2728 Cible choisie par l'IA (plusieurs commits touchent ces lignes) \u2014 v\u00e9rifie avant de confirmer.",
    aiAlternates: "Autres candidats propos\u00e9s :",
    noCandidateAiUnavailable: "Les modifications touchent plusieurs commits. Active un provider IA dans les r\u00e9glages pour obtenir un classement.",
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

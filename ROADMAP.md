# GitWand — Product Roadmap

> De "Git's magic wand" (résolution de conflits) à un client Git complet, visuel et intelligent.

---

## Vision

Devenir le client Git de référence qui combine la puissance visuelle de **Kaleidoscope** (comparaison de fichiers, images, dossiers), la simplicité workflow de **GitHub Desktop** (commit, push, pull, branches), et l'intelligence algorithmique unique de GitWand (résolution automatique de conflits) — le tout dans une app native cross-platform (Tauri).

**Positionnement** : GitWand n'est pas "encore un Git GUI". C'est un client Git qui *comprend* le code, résout les conflits triviaux tout seul, et rend visuel ce que le terminal cache.

---

## Analyse concurrentielle

### Kaleidoscope (macOS, ~150€/an)

Kaleidoscope excelle dans la **comparaison visuelle** :

| Capacité | Détail |
|----------|--------|
| Text diff | Diff caractère par caractère, thèmes syntaxiques, mode Reader épuré |
| Image diff | Split, blink, drag — détection pixel par pixel. JPEG, PNG, PSD, TIFF |
| Folder diff | Arbre de dossiers complet, Quick Look inline, sync bidirectionnelle |
| 3-way merge | Vue base + 2 branches, résultat éditable au centre |
| Git repos | Comparaison branches/tags/commits, changeset complet, file history |
| Intégrations | git difftool/mergetool, Tower, VS Code extension, ksdiff CLI |

**Points forts** : Qualité visuelle inégalée, image diff unique, folder diff.
**Faiblesses** : macOS only, pas de workflow Git (pas de commit/push/pull), prix élevé, pas d'auto-résolution.

### GitHub Desktop (gratuit, open-source)

GitHub Desktop excelle dans le **workflow Git simplifié** :

| Capacité | Détail |
|----------|--------|
| Clone/init | Interface guidée pour cloner ou créer un repo |
| Commit | Sélection partielle de lignes, co-auteurs, syntaxe colorée |
| Push/Pull | Sync one-click, pull with rebase |
| Branches | Création, switch, merge, delete. Drag-and-drop pour reorder |
| Merge conflicts | Détection + ouverture dans l'éditeur externe |
| Rebase | Rebase interactif avec drag-and-drop |
| Cherry-pick | Copie de commits entre branches |
| Stash | Stash automatique au switch de branche |
| PR workflow | Création, checkout de PRs, lien avec CI/CD |
| History | Vue chronologique des commits avec diff |
| Multi-repo | Gestion de plusieurs repos depuis une interface |

**Points forts** : Gratuit, simple, bon workflow PR, cherry-pick/rebase intuitifs.
**Faiblesses** : Diff basique (pas de 3-way, pas d'images), résolution de conflits rudimentaire (renvoi vers éditeur externe), Electron (lourd).

### GitButler (gratuit, open-source — [docs.gitbutler.com](https://docs.gitbutler.com/))

GitButler est le concurrent le plus proche de GitWand techniquement (même stack Tauri/Rust) :

| Capacité | Détail |
|----------|--------|
| Virtual branches | Travail parallèle sur N branches sans switch — les changements sont répartis visuellement |
| Stacked PRs | Découpe automatique d'une grosse branche en une chaîne de PRs empilées (rebase auto) |
| Butler Bot (IA) | Suggestions de messages de commit, résumés de changements, assistance au code review |
| Conflict flow | Détection des conflits à l'application des virtual branches, résolution inline |
| Undo / snapshot | Système de snapshots automatiques, undo granulaire sur chaque opération |
| SSH key management | Génération et gestion des clés SSH intégrée |
| GitHub integration | Création de PRs, CI status, review — directement depuis l'app |

**Points forts** : Virtual branches (concept unique), stacked PRs (workflow très productif), même stack Tauri/Rust (performance native), IA intégrée, gratuit et open-source.
**Faiblesses** : Pas de diff image, pas de folder diff, pas de 3-way merge visuel dédié, UX parfois déroutante pour les débutants (virtual branches = nouveau paradigme), pas de support GitLab/Bitbucket natif.

**Positionnement GitWand vs GitButler** : GitButler réinvente le workflow Git (virtual branches), GitWand améliore le workflow existant avec de l'intelligence (auto-resolve, suggestions de résolution). Les deux sont Tauri/Rust, mais GitWand cible aussi les développeurs qui veulent un client Git classique enrichi, pas un nouveau paradigme.

### Autres concurrents notables

| Client | Différenciateur clé |
|--------|---------------------|
| **GitKraken** | Graph de commits visuel, merge editor 3-way intégré, Jira/Trello intégré. $5/mois. |
| **Fork** | Performance native (pas Electron), rapide sur gros repos, interface propre. $50 one-time. |
| **Tower** | Conflict advisor, quick actions, undo puissant, SSH key management. $69/an. |
| **Sublime Merge** | Ultra-rapide, search puissant, intégré à Sublime Text. $99 one-time. |
| **SourceTree** | Gratuit (Atlassian), Bitbucket intégré, git-flow support. |

---

## Ce que GitWand a déjà (v0.1.0 → Phase 8)

### Core — moteur de résolution (Phases 1–7.5)
- **8 patterns de résolution** : same_change, one_side_change, delete_no_change, whitespace_only, non_overlapping, value_only_change, generated_file, complex — LCS 3-way, diff2 + diff3
- **Score de confiance composite** (`ConfidenceScore`) : score 0–100, dimensions typeClassification / dataRisk / scopeImpact, boosters[], penalties[], label backward-compatible
- **Résolveurs par format** : JSON/JSONC sémantique (fusion clé-par-clé récursive), Markdown section-aware (heading ATX), YAML par clés, imports TS/JS (union + tri par groupes), Vue SFC par blocs, CSS par règles, lockfiles sémantiques (npm/yarn/pnpm — merge par entrée de paquet), dispatcher automatique par extension
- **Politiques configurables** (`.gitwandrc`) : prefer-ours, prefer-theirs, prefer-safety, prefer-merge, strict — par projet et par pattern glob
- **DecisionTrace** : trace pas-à-pas de chaque décision de classification, mode explain-only
- **Corpus de référence** : 20 fixtures réalistes, métriques auto-résolution/faux-positifs, benchmarks (vitest bench)
- **332 tests** (core) — config, resolver, format-resolvers, corpus
- CLI `gitwand resolve` / `gitwand status`, mode CI/JSON
- Extension VS Code : diagnostics, CodeLens, status bar

### Desktop — Client Git complet (Phases 5–6)
- **Repository overview** : statut (branche, ahead/behind, clean/dirty), fichiers staged/unstaged/untracked, diff viewer par fichier
- **Commit & Push** : stage/unstage individuel + tout indexer, commit summary + description, signature configurable, push/pull (sync), Ctrl+Enter, indicateurs ahead/behind
- **Branches** : liste locale + remote, création/suppression, switch (spinner), tri par date (main/master en premier), popover header
- **Merge** : détection conflits (porcelain v2), merge editor VS Code-style avec recommandations inline, auto-save + git add + merge --continue automatique
- **History / Log** : vue chronologique, diff par commit, scroll-spy, carte commit avec avatar/stats/badges, collapse description (2 lignes + expand)
- **i18n** : système type-safe `useI18n()`, locales FR/EN complètes, détection OS, override dans Settings
- **Settings** : panneau dédié (langue, thème, signature de commit, mode diff)
- **Diff avancé** : side-by-side toggle, syntax highlighting (30+ langages), navigation hunk, collapse zones inchangées, numéros de ligne, word-level diff (LCS), minimap canvas, staging partiel lignes/hunks
- **File history** : blame inline (`git blame --porcelain`), historique fichier (`git log --follow`), time-travel diff
- **DAG graph** : visualisation graphe de commits (toutes branches), layout en lanes, SVG, ref badges
- **UX** : thème light/dark/system, toast notifications, empty state avec repos récents en cartes, auto-fetch toutes les 30s, stash/stash-pop

### Desktop — Workflows avancés (Phase 8)
- **Merge Preview** (8.1) : simuler un merge avant de le faire — zéro side-effect (`git merge-base` + `git show` + `git merge-file -p --diff3`), badge clean/auto/warn, statut par fichier (auto-resolved / partial / manual / add-delete)
- **Conflict prevention** (8.1) : alerte proactive quand deux branches touchent les mêmes fichiers — `ConflictAlert.vue`, commande Rust `git_conflict_check`
- **Amend commit** (8.2) : modifier le message du dernier commit non-pushé — overlay pré-rempli, Ctrl+Enter, `git commit --amend`
- **Cherry-pick** (8.2) : sélectionner des commits d'une branche à copier — `CherryPickPanel.vue`, multi-sélection, gestion conflits continue/abort
- **Stash manager** (8.2) : liste, apply, drop, pop, diff expandable — `StashManager.vue`, commandes Rust `git_stash_list/apply/drop/show`
- **PR workflow** (8.3) : créer/lister/checkout/merge des PRs GitHub via `gh` CLI — `PullRequestPanel.vue`, filtre par état, merge method chooser
- **Repo switcher** (8.4) : dropdown depuis le nom du repo courant — repos récents avec pin/unpin/suppression, ouverture directe
- **Monorepo awareness** (8.4) : détection pnpm/npm/yarn workspaces — `MonorepoPanel.vue`, scan packages avec nom/chemin/version
- **Terminal intégré** (8.5) : exécution commandes git inline — `GitTerminal.vue`, autocomplete branches/tags/sous-commandes, historique navigable
- **Infrastructure Tauri 2** : capabilities system (dialog:allow-open), config plugins corrigée, artefacts gen/ ignorés

---

## Roadmap — Now / Next / Later

### NOW — Phase 5 : Client Git de base ✅ (Terminé)

> Objectif : Transformer GitWand d'un "merge conflict resolver" en un vrai client Git utilisable au quotidien.
> **Statut : TERMINÉ** — Toutes les fonctionnalités de base sont implémentées et fonctionnelles.

#### 5.1 — Repository overview ✅

- ✅ **Vue repo** : Statut du repo (branche courante, ahead/behind via rev-list, clean/dirty)
- ✅ **Fichiers modifiés** : Liste staged, unstaged, untracked (parsing porcelain v2 type 1, 2, u)
- ✅ **Diff viewer** : Diff de chaque fichier modifié (vue inline)
- ⬜ **Diff side-by-side** : Toggle inline vs side-by-side (reporté Phase 6)

#### 5.2 — Commit & Push ✅

- ✅ **Zone de staging** : Stage/unstage par fichier + bouton "Tout indexer"
- ⬜ **Staging partiel** : Sélection de lignes/hunks (reporté Phase 6)
- ✅ **Message de commit** : Summary (requis) + Description (optionnel), signature "🪄 Commit via GitWand" configurable
- ✅ **Commit** : Bouton commit + raccourci Ctrl+Enter
- ✅ **Push/Pull** : Sync (fetch all + pull) + Push dans le header, indicateurs ahead/behind
- ⬜ **Pull with rebase** : Option rebase (reporté — paramètre Settings prévu)

#### 5.3 — Branches ✅

- ✅ **Liste des branches** : Locales + remote, indicateur branche courante, popover dans le header
- ✅ **Créer/supprimer** une branche
- ✅ **Switch** de branche (avec spinner de chargement)
- ✅ **Merge** d'une branche → détection conflits + merge editor VS Code-style si conflits
- ✅ **Tri intelligent** : main/master en premier, puis par date de dernier commit

#### 5.4 — History / Log ✅

- ✅ **Vue log** : Liste chronologique dans la sidebar, carte commit avec avatar/stats/badges
- ✅ **Diff par commit** : Clic sur un commit → liste de fichiers + diff, scroll-spy
- ⬜ **Graphe simplifié** : Visualisation DAG des branches (reporté Phase 6)

#### 5.5 — Internationalisation & Paramètres ✅

- ✅ **Système i18n** : Composable `useI18n()` type-safe, locales FR/EN complètes, détection OS
- ✅ **Migration des strings** : Toutes les chaînes migrées vers `t('key')`
- ✅ **Menu Paramètres** : Panneau accessible depuis le header (icône engrenage)

Paramètres implémentés :

> Légende : ✅ UI + persistance + logique câblée — ⚠️ UI + persistance uniquement (valeur stockée, pas encore consommée par la logique) — ⬜ non implémenté

| Paramètre | Statut | Valeurs |
|-----------|--------|---------|
| **Langue** | ✅ | Automatique (OS), Français, English |
| **Thème** | ✅ | Sombre, Clair, Système (OS) |
| **Signature de commit** | ✅ | Activée/Désactivée (🪄 Commit via GitWand) |
| **Affichage diff** | ✅ | Inline (unifié), Side-by-side |
| **Pull mode** | ✅ | Merge (défaut), Rebase |
| **Taille de police** | ✅ | 10-18px, slider (défaut 12px), CSS custom property |
| **Tab size** | ✅ | 2, 4, 8 espaces, CSS custom property |
| **Éditeur externe** | ✅ | Champ texte libre — bouton dans le diff header, commande Tauri `open_in_editor`, fallback `code` |
| **Chemin Git** | ✅ | Automatique (PATH) ou chemin personnalisé — `GIT_BINARY` OnceLock Rust + `set_git_config`, appliqué au démarrage et à la fermeture des Settings |
| **Branche par défaut** | ✅ | `main`, `master`, personnalisé — `priorityNames` computed dans BranchPanel, toujours premier dans le tri |
| **Comportement au switch** | ✅ | Stash automatique (`git stash --include-untracked` + pop), Demander (window.confirm), Refuser (erreur toast) |
| **Notifications** | ✅ | Activées/Désactivées — gate dans le watcher `repoSuccess` de App.vue |
| **Raccourcis clavier** | ⬜ | Tableau éditable (phase ultérieure) |

#### Bonus Phase 5 (non planifiés, implémentés)

- ✅ **Auto-fetch** : Fetch toutes les 30s + fetch all au Sync
- ✅ **Toast notifications** : Dark card, bottom-right, slide-in/out, auto-dismiss
- ✅ **Empty state** : Repos récents en cartes visuelles
- ✅ **Merge editor avancé** : Recommandations inline, auto-save, merge --continue automatique
- ✅ **Commit signature** : "🪄 Commit via GitWand" configurable dans Settings

---

### NOW — Phase 6 : Diff & comparaison avancée (quasi-terminé — 6.2 et 6.3 restants)

> Objectif : Rivaliser avec Kaleidoscope sur la qualité visuelle des diffs, tout en gardant l'intelligence GitWand.
> **Statut** : 6.0, 6.1 et 6.4 sont terminés. Restent 6.2 (folder diff) et 6.3 (image diff).

#### 6.0 — Reports Phase 5 ✅

- ✅ **Diff side-by-side** : Toggle inline/côte-à-côte avec persistance Settings (DiffViewer + CommitDiffViewer)
- ✅ **Staging partiel** : Sélection de lignes/hunks à commiter, via `git apply --cached` — checkboxes par ligne et par hunk, bouton "Stage hunk" et "Stage selected", patch builder, trois couches (Rust + dev-server + TypeScript)
- ✅ **Pull with rebase** : Option rebase dans Settings, paramètre persisté en localStorage
- ✅ **Graphe simplifié** : Visualisation DAG des branches — layout en lanes, SVG graph (nodes + edges bezier), ref badges (branch/tag/remote), sélection de commit
- ✅ **Paramètres restants** : Pull mode, comportement au switch, taille de police (10-18px slider), tab size (2/4/8), notifications — tous avec persistance localStorage et CSS custom properties

#### 6.1 — Diff enrichi ✅

- ✅ **Syntax highlighting** : highlight.js avec 30+ langages, détection auto par extension, thèmes dark/light
- ✅ **Word-level diff** : Algorithme LCS sur tokens mot, `DiffSegment[]` (equal/delete/insert), spans HTML `.wd-del`/`.wd-ins`, inline + side-by-side + compare views
- ✅ **Minimap** : Canvas 48px, rendu proportionnel add/delete, viewport indicator, click-to-scroll, device pixel ratio aware
- ✅ **Navigation hunk** : Boutons prev/next avec compteur (1/N), scroll-to-hunk
- ✅ **Collapse unchanged** : Masquage automatique des longues séries context (>6 lignes), expand on click, `IndexedLine` wrapper pour word-diff mapping
- ✅ **Numéros de ligne** : Double-colonne (ancien/nouveau) — déjà présent depuis Phase 5

#### 6.2 — Folder diff

- ⬜ **Comparer deux dossiers** : Arbre récursif avec indicateurs ajouté/supprimé/modifié
- ⬜ **Comparer deux branches** : Vue des fichiers différents entre deux refs Git
- ⬜ **Comparer deux commits** : Changeset complet entre N'importe quels commits
- ⬜ **Filtrage** : Par type de fichier, par pattern glob, par type de changement

#### 6.3 — Image diff (différenciateur fort)

- ⬜ **Comparaison visuelle** : Side-by-side, overlay, blink, slider (split)
- ⬜ **Formats** : PNG, JPEG, SVG, WebP, GIF
- ⬜ **Détection pixel** : Heatmap des zones modifiées
- ⬜ **Métadonnées** : Taille, dimensions, profil couleur

#### 6.4 — File history ✅

- ✅ **Historique d'un fichier** : `git log --follow`, vue chronologique avec avatar/date/hash
- ✅ **Blame inline** : `git blame --porcelain`, groupement par commit, syntax highlighting, clic → commit
- ✅ **Time-travel diff** : Comparer n'importe quelles deux versions d'un fichier — onglet "Compare", sélection de 2 commits dans le log, `git diff <from> <to> -- <file>`, vue SBS avec word-diff

#### Bonus Phase 6 (non planifiés, implémentés)

- ✅ **Paramètre diff display** : Choix inline/side-by-side dans Settings avec persistance
- ✅ **Bouton File History** : Icône horloge dans le header du diff pour ouvrir l'historique du fichier
- ✅ **i18n Phase 6** : Toutes les nouvelles clés traduites FR/EN (diff modes, collapsed, hunk nav, file history)

#### 6.5 — Paramètres : câblage de la logique

Les paramètres suivants ont leur UI et leur persistance mais ne sont pas encore consommés par la logique applicative.

- ✅ **Notifications** : flag `notifications` consommé dans le système de toasts — aucun toast si désactivé
- ✅ **Comportement au switch** : `switchBehavior` lu lors du switch — `stash` (stash auto + switch + pop), `ask` (window.confirm si dirty), `refuse` (erreur si working tree dirty)
- ✅ **Branche par défaut** : `defaultBranch` consommé dans le tri des branches (`priorityNames` computed, remplace le hardcode `["main","master"]`)
- ✅ **Éditeur externe** : commande Tauri `open_in_editor` + bouton dans le diff header — fallback `code` si non configuré
- ✅ **Chemin Git** : `GIT_BINARY` OnceLock global en Rust, commande `set_git_config` pour le mettre à jour depuis le frontend — tous les 26 appels `Command::new` utilisent `git_binary()`, fallback `git` si vide

**Effort estimé restant** : 2-3 semaines. Folder diff (6.2) et image diff (6.3) sont les derniers éléments structurants. La 6.5 est du câblage, estimé à 2-3 jours.

---

### NEXT — Phase 7 : Hardening du core de résolution (2-4 semaines)

> Objectif : Rendre le moteur plus explicite, plus prévisible, plus format-aware et plus vérifiable.
> Basé sur l'[analyse technique du core](./docs/core-analyse.md) — audit complet du pipeline parse → classify → resolve → merge.

#### Constat

Le core actuel est un moteur déterministe, lisible et sûr. Ses forces :

- **Déterminisme** : même entrée = même sortie (fondamental pour CI, audit, debug)
- **Typage fort** : `ConflictType`, `Confidence`, `ConflictHunk`, `MergeResult`, `HunkResolution` — contrat stable entre couches
- **Explicabilité** : chaque classification renvoie une `explanation`
- **Garde-fou** : le type `complex` évite la sur-résolution
- **Extensibilité** : architecture ouverte à de nouveaux types et heuristiques

Ses faiblesses identifiées :

- Moteur purement textuel, pas syntax-aware (fragile sur JSON, YAML, Vue SFC, CSS, lockfiles)
- `whitespace_only` trop naïf (trim ligne par ligne, pas d'indentation fine)
- `value_only_change` heuristique (tokenisation simplifiée, regex, seuils — perçu comme "magique")
- `non_overlapping` sensible au déplacement de blocs (LCS O(n*m))
- Confiance discrète (label, pas score de preuve)
- Pas de validation post-résolution (marqueurs résiduels, cohérence syntaxique)
- Politiques implicites (`value_only_change` → theirs, `whitespace_only` → ours) non documentées ni configurables

#### 7.1 — Rendre visible : `DecisionTrace` ✅

- ✅ **`DecisionTrace` par hunk** : trace structurée dans chaque `ConflictHunk` — `steps[]` (type + passed + reason), `selected`, `summary`, `hasBase`
- ✅ **Exposer les raisons de non-résolution** : `resolutionReason` dans chaque `HunkResolution` — explique pourquoi auto-résolu ou non
- ✅ **"Explain only" mode** : option `explainOnly: true` dans `GitWandOptions` — classifie et trace sans appliquer de résolution
- ✅ **Enrichir les tests** : 12 nouveaux tests Phase 7.1 couvrant trace, steps, resolutionReason, explainOnly, hasBase diff2/diff3

```ts
// Nouvelle interface à ajouter dans types.ts
interface DecisionTrace {
  candidates: ConflictType[];
  selected: ConflictType;
  score: number;
  reason: string;
  rejectedBy: Array<{ candidate: ConflictType; reason: string }>;
}
```

#### 7.2 — Rendre plus fiable : validation post-merge (priorité haute)

- ✅ **Vérification post-fusion** : `validateMergedContent()` scanne le contenu fusionné pour détecter les marqueurs résiduels (`<<<<<<<`, `>>>>>>>`, `|||||||`, `=======`) avec numéros de ligne
- ✅ **Validation syntaxique JSON** : `JSON.parse()` sur les `.json` et `.jsonc` — `syntaxError` dans `ValidationResult`
- ✅ **`ValidationResult` dans `MergeResult`** : `{ hasResidualMarkers, residualMarkerLines, syntaxError, isValid }` — exposé à la CLI et à l'UI
- ✅ **7 nouveaux tests Phase 7.2** couvrant marqueurs résiduels, validation JSON, fichiers non-JSON
- ✅ **Meilleure normalisation whitespace** : `normalizeForWhitespaceCheck()` — tabs→spaces, trim, collapse interne, suppression des lignes vides de tête/queue ; détection robuste tab vs espace
- ✅ **Réglage des seuils de confiance** : seuils `value_only_change` affinés (≤10% → 88, ≤20% → 72, ≤30% → 55, >30% rejeté) ; patterns VOLATILE_PATTERNS ancrés pour éviter les faux positifs sur identifiants camelCase

#### 7.3 — Rendre plus intelligent : résolveurs par format (priorité moyenne) ✅

- ✅ **Résolveur JSON/JSONC sémantique** (`resolvers/json.ts`) — fusion clé-par-clé récursive avec `JSON.parse`/`JSON.stringify` ; merge d'objets imbriqués ; détection de conflits scalaires non résolvables ; `stripJsoncComments` pour les `.jsonc` ; fallback textuel si les sections de conflit ne sont pas du JSON valide
- ✅ **Résolveur Markdown section-aware** (`resolvers/markdown.ts`) — découpage en sections par heading ATX (H1..H6) ; `parseSections`, `extractFrontmatter` ; merge section par section ; gestion ajout/suppression de sections ; fallback si une section est modifiée des deux côtés
- ✅ **Dispatcher automatique** (`resolvers/dispatcher.ts`) — `tryFormatAwareResolve(hunk, filePath)` ; `isJsonFile`/`isMarkdownFile` ; résolveur spécialisé tenté en premier pour les formats reconnus, fallback textuel sinon ; `resolverUsed` dans la réponse pour la trace
- ✅ **Branché dans resolver.ts** — `resolveHunk` accepte `filePath`, appelle `tryFormatAwareResolve` avant le moteur textuel ; bypass du filtre de confiance pour les résolutions sémantiquement validées (JSON) ; `resolutionReason` préfixé `[json]` ou `[markdown]`
- ✅ **44 tests** dans `format-resolvers.test.ts` — `stripJsoncComments`, `tryResolveJsonConflict` (7 cas), objets imbriqués, base vide, JSON malformé, intégration via `resolve()`, `parseSections`, `extractFrontmatter`, `tryResolveMarkdownConflict` (5 cas), dispatcher (7 cas)
- ✅ **54 tests Phase 7.2/7.3b** dans `phase-7-2-3b.test.ts` — normalisation whitespace (5 cas), `value_only_change` affinés (8 cas), YAML (10 cas), imports TS/JS (12 cas), Vue SFC (8 cas), CSS/SCSS (7 cas), dispatcher (4 cas)
- ✅ **Phase 7.3b — Formats restants** : YAML (`resolvers/yaml.ts`), Vue SFC (`resolvers/vue.ts`), TS/JS imports (`resolvers/imports.ts`), CSS/SCSS/Less (`resolvers/css.ts`) — résolution sémantique règle par règle / bloc par bloc / import par import ; dispatch automatique dans `dispatcher.ts` ; gate de politique pour le résolveur d'imports (équivalent `non_overlapping`)
- ✅ **Score de confiance composite** : `ConfidenceScore` remplace le label discret — `score` 0–100, `dimensions` (typeClassification / dataRisk / scopeImpact), `boosters[]`, `penalties[]`, `label` backward-compatible ; `makeScore()` dans `parser.ts` ; `hunk.confidence.label` partout dans le moteur et l'UI

**Note d'implémentation** : le résolveur JSON fonctionne quand chaque section de conflit (ours/base/theirs) est un JSON autonome valide (ex: fichier entier en conflit). Pour les conflits partiels (fragment d'objet), il revient gracieusement au moteur textuel.

#### 7.4 — Rendre configurable : stratégies de merge (priorité moyenne) ✅

- ✅ **Politiques explicites** : `prefer-ours`, `prefer-theirs`, `prefer-safety`, `prefer-merge`, `strict` — implémentées dans `packages/core/src/config.ts`
- ✅ **Configuration par projet** : fichier `.gitwandrc` / `.gitwandrc.json` / `package.json#gitwand` — `parseGitwandrc()` + commande Rust `read_gitwandrc`
- ✅ **Overrides par pattern** : stratégie différente selon le glob du fichier (ex: `*.lock` → `prefer-theirs`) — `matchGlob()` + `effectivePolicyForFile()` + `patternOverrides` dans `GitWandOptions`
- ✅ **Documentation des conventions** : JSDoc complet dans `config.ts` — tableau des politiques, choix implicites du moteur, format `.gitwandrc`
- ✅ **Intégration desktop** : `resolveOptions` ref dans `useGitWand.ts`, chargée depuis `.gitwandrc` au scan du repo, passée à tous les appels `resolve()`
- ✅ **35 tests Phase 7.4** : matchGlob (11), effectivePolicyForFile (5), policyToConfig (5), parseGitwandrc (5), intégration via resolve() (14) — 181/181 tests au total

#### 7.5 — Rendre mesurable : corpus et métriques (priorité basse) ✅

- ✅ **Corpus de 20 fixtures réalistes** (`corpus.ts`) — couvre tous les ConflictType (same_change, one_side_change, delete_no_change, non_overlapping, whitespace_only, value_only_change, generated_file, complex), diff2 + diff3, fichiers variés (TS, CSS, JSON, Markdown, lockfile, manifest)
- ✅ **Métriques de résolution** (`corpus.test.ts`) — taux global d'auto-résolution, taux par catégorie, faux positifs/négatifs, score de confiance par type ; rapport console activable via `CORPUS_METRICS=1`
- ✅ **Détection de régression** — les 24 tests corpus (`vitest run`) vérifient la stabilité de classification et de résolution à chaque changement du moteur
- ✅ **Benchmarks de performance** (`bench.bench.ts`, `vitest bench --run`) — résultats baseline :
  - 1 conflit / ~30 lignes  → **~249 000 ops/s** (0.004 ms/op)
  - 5 conflits / ~140 lignes → **~40 000 ops/s** (0.025 ms/op)
  - 20 conflits / ~530 lignes → **~9 900 ops/s** (0.10 ms/op)
  - 50 conflits / ~1350 lignes → **~4 500 ops/s** (0.22 ms/op)
  - JSON/Markdown format-aware → **~137 000 ops/s** (0.007 ms/op)
- ✅ **`vitest.config.ts`** — exclut les `.bench.ts` du run normal ; script `test:bench` ajouté dans `package.json`
- ✅ **220/220 tests** au total (181 existants + 24 corpus + 54 Phase 7.2/7.3b + mises à jour corpus) — 440 assertions (src + dist)

**Effort estimé** : 2-4 semaines. 7.1 et 7.2 sont prioritaires et réduisent directement la perception de "magie" et les faux positifs.

---

### NOW — Phase 8 : Workflows avancés & intelligence ✅

> Objectif : Dépasser les concurrents avec des features que personne n'a.

#### 8.1 — Smart merge (différenciateur unique) ✅

- ✅ **Merge preview** : Simuler le résultat d'un merge avant de le faire — commande Rust `preview_merge` (merge-base + git show + git merge-file -p --diff3 zéro side-effect), composable `useMergePreview.ts`, `MergePreviewPanel.vue` ; badge clean/auto/warn, stats par catégorie, liste des fichiers conflictuels avec statut `auto-resolved`/`partial`/`manual`/`add-delete` ; bouton preview par branche dans le popover `AppHeader`
- ✅ **Auto-resolve étendu** : Trois axes implémentés —
  - **Lockfile sémantique** : résolveurs dédiés `lockfile-npm.ts` (package-lock.json — merge 3-way par entrée de paquet, merge propriété par propriété pour les conflits version/integrity), `lockfile-yarn.ts` (yarn.lock — merge par bloc header/body), `lockfile-pnpm.ts` (pnpm-lock.yaml — merge par section top-level + sous-entrées packages/snapshots). Dispatch automatique dans `dispatcher.ts` avant le résolveur JSON générique.
  - **Import ordering amélioré** : détection Node.js built-ins (50+ modules), groupes configurables (built-in → npm → scoped → alias internes → relatifs parents → siblings → index), stratégies de tri (`default`, `eslint-import`, `type-last`), insertion optionnelle de séparateurs entre groupes. Type exporté `ImportSortStrategy`.
  - **Generated files smart resolution** : comparaison structurelle après suppression des valeurs volatiles (SHA, integrity, timestamps, semver+build) — détecte les conflits cosmétiques dans les fichiers générés. Suggestion de régénération dans la raison de résolution.
- **Suggestions IA** : Pour les conflits complexes, proposer des résolutions basées sur le contexte
- ✅ **Conflict prevention** : Commande Rust `git_conflict_check` détecte les fichiers modifiés en commun entre la branche courante et une branche cible via merge-base + diff --name-only ; composant `ConflictAlert.vue` affiche un avertissement visuel avec badge warning/danger selon le nombre de fichiers en commun, liste des fichiers, et stats par branche ; wrapper TypeScript `gitConflictCheck` dans `backend.ts`

#### 8.2 — Rebase & cherry-pick interactif ✅ (Cherry-pick + Stash Manager livrés)

- ✅ **Amend** : Modifier le message du dernier commit non-pushé — overlay pré-rempli (summary + description), Ctrl+Enter, commande Rust `git commit --amend`, bouton crayon dans le log
- **Rebase interactif** : Drag-and-drop pour réordonner, squash, edit, drop (reporté — complexité UI importante)
- ✅ **Cherry-pick** : Commandes Rust `git_cherry_pick` / `git_cherry_pick_abort` / `git_cherry_pick_continue` ; composant `CherryPickPanel.vue` avec sélecteur de branche, liste multi-sélection de commits, gestion des conflits (continue/abort) ; intégration dans le composable `useGitRepo.ts` avec méthodes `cherryPick`, `cherryPickAbort`, `cherryPickContinue`
- ✅ **Stash manager** : Commandes Rust `git_stash_list` / `git_stash_apply` / `git_stash_drop` / `git_stash_show` ; composant `StashManager.vue` avec liste des stashes (message, branche, date), boutons apply/drop par stash, diff expandable par clic, création et pop rapides ; wrapper TypeScript complet dans `backend.ts`

#### 8.3 — PR workflow ✅ (GitHub via `gh` CLI)

- ✅ **Créer une PR** : Formulaire intégré dans `PullRequestPanel.vue` (titre, description, branche base, option draft) ; commande Rust `gh_create_pr` via `gh pr create`
- ✅ **Vue PR** : Liste des PRs ouvertes/fermées/toutes avec auteur, branche, stats +/-, labels, badges draft ; commande Rust `gh_list_prs` via `gh pr list --json` ; filtre par état
- ✅ **Checkout de PR** : Basculer localement sur la branche d'une PR ; commande Rust `gh_checkout_pr` via `gh pr checkout`
- ✅ **Merge PR** : Merge/squash/rebase depuis l'app avec dialogue de choix de méthode ; commande Rust `gh_merge_pr` via `gh pr merge`
- ✅ **Remote detection** : Commande Rust `git_remote_info` détecte le provider (GitHub/GitLab/Bitbucket) et extrait owner/repo depuis l'URL remote
- **Intégrations GitLab/Bitbucket** : Support API natif (actuellement via `gh` CLI pour GitHub uniquement)

> Le PR workflow est le point d'entrée naturel vers la Phase 9 — Code Review intégré.
> Une fois les PRs affichables dans l'app, ajouter le review inline devient la suite logique.

#### 8.4 — Multi-repo & workspace ✅

- ✅ **Repo switcher** : Dropdown depuis le nom du repo courant dans le header — liste des repos récents (`useFolderHistory` singleton), pin/unpin, suppression depuis l'historique, ouverture directe ; `openRepo` event vers `App.vue`
- ✅ **Monorepo awareness** : Commande Rust `detect_monorepo` détecte pnpm-workspace.yaml, package.json workspaces (npm/yarn) ; scan des packages avec nom, chemin, version ; composant `MonorepoPanel.vue` avec filtre, icône par manager, liste cliquable ; wrapper TypeScript `detectMonorepo` dans `backend.ts`
- **Tabs** : Ouvrir plusieurs repos en parallèle
- **Raccourcis globaux** : Cmd+Shift+G pour ouvrir GitWand depuis n'importe où

#### 8.5 — Terminal intégré ✅

- ✅ **Terminal inline** : Composant `GitTerminal.vue` — exécution de commandes git dans le repo via commande Rust `git_exec` (sécurisé, git-only) ; affichage stdout/stderr avec coloration, exit code, historique scrollable
- ✅ **Autocomplete** : Commande Rust `git_autocomplete` fournit suggestions de sous-commandes git et noms de branches/tags ; navigation clavier (Tab, flèches), sélection par clic
- ✅ **History** : Historique des commandes avec navigation flèches haut/bas, résultats inline

---

### LATER — Phase 9 : Code Review intégré (6-12 mois)

> Objectif : Faire de GitWand un outil de code review à part entière — pas un renvoi vers GitHub.
> La fondation est déjà là : diff viewer side-by-side, word-level diff, syntax highlighting, navigation hunk, file history, DAG graph. Il manque la couche "collaboration" par-dessus.

**Positionnement** : GitHub et GitLab ont des interfaces de review correctes mais déconnectées du contexte local. GitWand connaît *votre* repo en profondeur — historique, conflits passés, patterns de merge — et peut apporter de l'intelligence là où les autres affichent juste un diff statique.

#### 9.1 — Visualisation de PR

- ⬜ **Liste des PRs** : Toutes les PRs ouvertes (GitHub/GitLab), avec statut CI, auteur, âge, nombre de commentaires
- ⬜ **Diff de PR complet** : Affichage du diff de la PR dans le diff viewer GitWand (toutes les forces de Phase 6 : SBS, word-diff, minimap, collapse, syntax highlighting)
- ⬜ **Résumé de PR** : Titre, description, reviewers assignés, labels, checks CI — vue agrégée
- ⬜ **Checkout local** : Basculer sur la branche de la PR en un clic pour tester localement
- ⬜ **Liens croisés** : Lien commit ↔ PR ↔ CI run pour naviguer sans quitter l'app

#### 9.2 — Commentaires inline

- ⬜ **Lecture des commentaires** : Afficher les commentaires existants de la PR directement dans le diff, ancrés sur les lignes concernées
- ⬜ **Répondre à un commentaire** : Thread de réponses inline, resolve/unresolve
- ⬜ **Créer un commentaire** : Sélectionner une ligne ou une plage de lignes → popin d'écriture contextuelle
- ⬜ **Commentaire multi-ligne** : Sélection de bloc (comme GitHub, drag de la gouttière)
- ⬜ **Suggestions de code** : Insérer un bloc ` ```suggestion ``` ` qu'on peut appliquer directement

#### 9.3 — Soumission de review

- ⬜ **Approve / Request changes / Comment** : Soumettre une review complète depuis l'app (équivalent du bouton "Review changes" sur GitHub)
- ⬜ **Brouillon de review** : Accumuler des commentaires localement avant de les envoyer tous en une fois
- ⬜ **Résumé de review** : Message global en accompagnement de la review
- ⬜ **Notification de merge possible** : Alerter quand tous les checks sont verts et les reviews approuvées

#### 9.4 — Intelligence GitWand (différenciateur clé)

C'est ici que GitWand se distingue vraiment des interfaces de review classiques :

- ⬜ **Conflict prediction** : Avant de merger une PR, simuler le merge contre la branche cible et détecter les conflits probables — avec les suggestions de résolution du moteur GitWand. *Aucun autre client Git ne fait ça à l'étape de la review.*
- ⬜ **Hotspot analysis** : Identifier les fichiers de la PR qui ont le plus souvent généré des conflits dans l'historique du repo — alerter le reviewer
- ⬜ **Review scope** : Mesurer l'ampleur du changement (fichiers touchés, % de la codebase, profondeur dans l'arbre de dépendances) pour calibrer le niveau de vigilance
- ⬜ **Suggestions de review IA** : Pour chaque hunk complexe, proposer des observations automatiques (breaking change potentiel, pattern inhabituel, divergence avec les conventions du repo) — en s'appuyant sur le moteur d'explication du core (Phase 7.1)
- ⬜ **Historique de review** : Qui a reviewé quoi dans ce fichier, quelles lignes ont déjà été commentées dans des PRs précédentes

**Effort estimé** : 3-6 mois. 9.1 est le prérequis naturel de 8.3, et peut être parallélisé avec 8.3. 9.4 (intelligence) vient en dernier, une fois 9.1-9.3 stables — et s'appuie directement sur les travaux Phase 7.

---

## Principes de design

1. **Intelligence d'abord** : Chaque écran doit apporter plus que le terminal. Si l'UI ne fait que wrapper `git status`, elle ne sert à rien. GitWand doit *comprendre* et *aider*.

2. **Performance native** : Tauri + Rust, pas Electron. L'app doit ouvrir en < 1s et rester fluide sur des repos de 100k+ commits.

3. **Progressif** : L'app fonctionne immédiatement pour les cas simples (ouvrir un repo, voir les conflits, résoudre). Les features avancées se découvrent progressivement.

4. **Cross-platform** : macOS, Linux, Windows. La même qualité partout (contrairement à Kaleidoscope qui est macOS-only).

5. **Gratuit et open-source** : Le core et le desktop restent MIT. Possible modèle freemium plus tard (features pro/team), mais l'essentiel reste libre.

---

## Dépendances techniques

| Feature | Dépendance |
|---------|------------|
| i18n (FR/EN) | Système maison : locales TypeScript typées + composable `useI18n()` |
| Paramètres | localStorage + composable `useSettings()`, panneau UI dédié |
| Commandes Git (status, add, commit, push, pull, log, branch) | Nouveaux Tauri commands en Rust exécutant des process Git |
| Syntax highlighting | tree-sitter (Rust/WASM) ou highlight.js (JS) |
| DecisionTrace / explain mode | Modification interne du core (`resolver.ts`, `types.ts`) |
| Validation post-merge | Parseurs légers par format : `JSON.parse`, `yaml`, `@babel/parser`, `postcss` |
| Résolveurs spécialisés | Parseurs structurels par type de fichier, dispatch dans `resolver.ts` |
| Score de confiance composite | Refactoring `Confidence` → `ConfidenceScore` dans `types.ts` |
| Corpus de conflits | Fixtures anonymisées, CI pipeline dédié |
| Image diff | Canvas API côté frontend, lib Rust pour pixel diff |
| Git graph | Algorithme de layout DAG (custom ou lib) |
| PR workflow | API GitHub/GitLab/Bitbucket (REST ou GraphQL) |
| Code review — commentaires inline | API GitHub Review Comments / GitLab MR Notes, stockage local des brouillons |
| Conflict prediction (Phase 9.4) | Simulation de merge en mémoire via le moteur Rust, sans toucher au working tree |
| Hotspot analysis (Phase 9.4) | `git log --follow -p` + parsing historique des conflits passés |
| Terminal intégré | tauri-plugin-shell ou pseudo-terminal |

---

## Risques

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Scope creep : trop de features Git = jamais fini | Haut | Livrer phase par phase, itérer |
| Performance sur gros repos (100k+ commits, monorepos) | Moyen | Rust pour le parsing Git, pagination, lazy loading |
| Concurrence forte (GitKraken, Fork, GitButler) | Moyen | Se différencier par l'intelligence (auto-resolve, suggestions) |
| Maintenance cross-platform | Moyen | CI/CD multi-OS déjà en place |
| Complexité du rebase interactif | Moyen | Reporter à Phase 8, commencer par les cas simples |
| **Faux positifs "raisonnables" du core** | **Haut** | **Phase 7 : DecisionTrace + validation post-merge + corpus de tests réels** |
| **Perception de "magie"** | **Moyen** | **Phase 7 : explain-only mode, politiques documentées, score composite** |
| **Fragilité sur formats structurés** (JSON, YAML, Vue SFC, lockfiles) | **Moyen** | **Phase 7.3 : résolveurs spécialisés par format** |
| **Heuristiques non contractuelles** (value_only, whitespace) | **Moyen** | **Phase 7.4 : politiques configurables + `.gitwandrc`** |

---

## Sources

- [Kaleidoscope — Git Diff and Merge Tool](https://kaleidoscope.app/)
- [Kaleidoscope 5 — merge conflict resolution (9to5Mac)](https://9to5mac.com/2024/11/29/kaleidoscope-merge-conflict-resolution/)
- [Kaleidoscope 5 — Git Repositories update (9to5Mac)](https://9to5mac.com/2024/07/09/kaleidoscope-git-repositories/)
- [GitHub Desktop — About (GitHub Docs)](https://docs.github.com/en/desktop/overview/about-github-desktop)
- [Best Git GUI Clients 2025 (DEV Community)](https://dev.to/_d7eb1c1703182e3ce1782/best-git-gui-clients-in-2025-gitkraken-sourcetree-fork-and-more-compared-4gjd)
- [GitButler — Virtual Branches & Stacked PRs](https://github.com/gitbutlerapp/gitbutler)
- [GitButler Documentation](https://docs.gitbutler.com/)
- [Top Git GUI Clients 2026 (LithiumGit)](https://lithiumgit.com/most-popular-git-gui-clients)

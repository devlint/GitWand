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

## Ce que GitWand a déjà (v0.1.0)

### Core (inchangé)
- Moteur de résolution automatique (5 patterns, LCS 3-way, 39 tests)
- CLI `gitwand resolve` / `gitwand status`, mode CI/JSON
- Extension VS Code : diagnostics, CodeLens, status bar

### Desktop — Client Git fonctionnel
- **Repository overview** : Statut du repo (branche courante, ahead/behind, clean/dirty), fichiers staged/unstaged/untracked, diff viewer par fichier
- **Commit & Push** : Stage/unstage individuel + "Tout indexer", commit avec Summary (requis) + Description (optionnel), signature "🪄 Commit via GitWand" configurable, push/pull (Sync), Ctrl+Enter, indicateurs ahead/behind
- **Branches** : Liste locale + remote, création/suppression, switch (avec spinner), tri par date (main/master en premier), popover dans le header
- **Merge** : Détection des conflits (porcelain v2), merge editor VS Code-style avec recommandations inline, auto-save + git add + merge --continue automatique, pause auto-fetch pendant merge
- **History / Log** : Vue chronologique des commits dans la sidebar, diff par commit avec liste de fichiers (scroll-spy), carte commit avec avatar/stats/badges, rechargement après commit/push/pull
- **i18n** : Système type-safe `useI18n()`, locales FR/EN complètes, détection OS
- **Settings** : Panneau dédié (langue, thème, signature de commit)
- **Diff avancé** : Side-by-side toggle avec persistance, syntax highlighting (highlight.js, 30+ langages), navigation hunk (prev/next), collapse des zones inchangées, numéros de ligne double-colonne
- **File history** : Blame inline (`git blame --porcelain`) avec groupement par commit, historique du fichier (`git log --follow`), syntax highlighting
- **UX** : Thème light/dark, toast notifications (dark card, slide-in/out), empty state avec repos récents en cartes, auto-fetch toutes les 30s, historique de dossiers/favoris

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

| Paramètre | Statut | Valeurs |
|-----------|--------|---------|
| **Langue** | ✅ | Automatique (OS), Français, English |
| **Thème** | ✅ | Sombre, Clair |
| **Signature de commit** | ✅ | Activée/Désactivée (🪄 Commit via GitWand) |
| **Éditeur externe** | ⬜ | `code`, `vim`, `nano`, chemin personnalisé |
| **Chemin Git** | ⬜ | Automatique (PATH) ou chemin personnalisé |
| **Branche par défaut** | ⬜ | `main`, `master`, personnalisé |
| **Comportement au switch** | ⬜ | Stash automatique, Demander, Refuser |
| **Pull mode** | ⬜ | Merge (défaut), Rebase |
| **Affichage diff** | ⬜ | Inline (unifié), Side-by-side |
| **Taille de police** | ⬜ | 10-18px, défaut 12px |
| **Tab size** | ⬜ | 2, 4, 8 espaces |
| **Notifications** | ⬜ | Activées, Désactivées |
| **Raccourcis clavier** | ⬜ | Tableau éditable (phase ultérieure) |

#### Bonus Phase 5 (non planifiés, implémentés)

- ✅ **Auto-fetch** : Fetch toutes les 30s + fetch all au Sync
- ✅ **Toast notifications** : Dark card, bottom-right, slide-in/out, auto-dismiss
- ✅ **Empty state** : Repos récents en cartes visuelles
- ✅ **Merge editor avancé** : Recommandations inline, auto-save, merge --continue automatique
- ✅ **Commit signature** : "🪄 Commit via GitWand" configurable dans Settings

---

### NOW — Phase 6 : Diff & comparaison avancée (en cours)

> Objectif : Rivaliser avec Kaleidoscope sur la qualité visuelle des diffs, tout en gardant l'intelligence GitWand.

#### 6.0 — Reports Phase 5 (partiel)

- ✅ **Diff side-by-side** : Toggle inline/côte-à-côte avec persistance Settings (DiffViewer + CommitDiffViewer)
- ⬜ **Staging partiel** : Sélection de lignes/hunks à commiter, comme `git add -p`
- ⬜ **Pull with rebase** : Option pour rebase au lieu de merge
- ⬜ **Graphe simplifié** : Visualisation DAG des branches
- ⬜ **Paramètres restants** : Comportement au switch, pull mode, taille de police, tab size, notifications

#### 6.1 — Diff enrichi (partiel)

- ✅ **Syntax highlighting** : highlight.js avec 30+ langages, détection auto par extension, thèmes dark/light
- ⬜ **Word-level diff** : Diff sémantique, pas juste token-level
- ⬜ **Minimap** : Vue miniature du fichier avec zones modifiées surlignées
- ✅ **Navigation hunk** : Boutons prev/next avec compteur (1/N), scroll-to-hunk
- ✅ **Collapse unchanged** : Masquage automatique des longues séries context (>6 lignes), expand on click
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
- ⬜ **Time-travel diff** : Comparer n'importe quelles deux versions d'un fichier

#### Bonus Phase 6 (non planifiés, implémentés)

- ✅ **Paramètre diff display** : Choix inline/side-by-side dans Settings avec persistance
- ✅ **Bouton File History** : Icône horloge dans le header du diff pour ouvrir l'historique du fichier
- ✅ **i18n Phase 6** : Toutes les nouvelles clés traduites FR/EN (diff modes, collapsed, hunk nav, file history)

**Effort estimé restant** : 2-3 semaines. Folder diff et image diff sont les plus coûteux.

---

### LATER — Phase 7 : Workflows avancés & intelligence (3-6 mois)

> Objectif : Dépasser les concurrents avec des features que personne n'a.

#### 7.1 — Smart merge (différenciateur unique)

- **Auto-resolve étendu** : Nouveaux patterns (import ordering, generated files, lockfiles)
- **Suggestions IA** : Pour les conflits complexes, proposer des résolutions basées sur le contexte
- **Conflict prevention** : Alerter en amont quand deux branches touchent les mêmes fichiers
- **Merge preview** : Simuler le résultat d'un merge avant de le faire

#### 7.2 — Rebase & cherry-pick interactif

- **Rebase interactif** : Drag-and-drop pour réordonner, squash, edit, drop
- **Cherry-pick** : Sélectionner des commits d'une branche à copier dans une autre
- **Amend** : Modifier le dernier commit (message et/ou contenu)
- **Stash manager** : Liste, apply, drop, pop des stashes

#### 7.3 — PR workflow

- **Créer une PR** : Formulaire intégré (titre, description, reviewers, labels)
- **Vue PR** : Liste des PRs ouvertes avec statut CI
- **Review inline** : Commenter directement depuis le diff
- **Merge PR** : Merge/squash/rebase depuis l'app
- **Intégrations** : GitHub, GitLab, Bitbucket

#### 7.4 — Multi-repo & workspace

- **Repo switcher** : Sidebar avec tous les repos récents
- **Monorepo awareness** : Afficher les packages/workspaces pour les monorepos pnpm/npm/yarn
- **Tabs** : Ouvrir plusieurs repos en parallèle
- **Raccourcis globaux** : Cmd+Shift+G pour ouvrir GitWand depuis n'importe où

#### 7.5 — Terminal intégré

- **Terminal inline** : Pour les commandes Git avancées non couvertes par l'UI
- **Autocomplete** : Suggestions de branches, remotes, fichiers
- **History** : Historique des commandes avec résultats

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
| Image diff | Canvas API côté frontend, lib Rust pour pixel diff |
| Git graph | Algorithme de layout DAG (custom ou lib) |
| PR workflow | API GitHub/GitLab/Bitbucket (REST ou GraphQL) |
| Terminal intégré | tauri-plugin-shell ou pseudo-terminal |

---

## Risques

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Scope creep : trop de features Git = jamais fini | Haut | Livrer Phase 5 d'abord, itérer |
| Performance sur gros repos (100k+ commits, monorepos) | Moyen | Rust pour le parsing Git, pagination, lazy loading |
| Concurrence forte (GitKraken, Fork, GitButler) | Moyen | Se différencier par l'intelligence (auto-resolve, suggestions) |
| Maintenance cross-platform | Moyen | CI/CD multi-OS déjà en place |
| Complexité du rebase interactif | Moyen | Reporter à Phase 7, commencer par les cas simples |

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

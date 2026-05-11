# GitWand — Product Roadmap

> Client Git natif avec résolution intelligente des conflits — Desktop, CLI, VS Code, MCP.

---

## Vision

Devenir le client Git de référence qui combine la puissance visuelle de **Kaleidoscope** (comparaison de fichiers, images, dossiers), la simplicité workflow de **GitHub Desktop** (commit, push, pull, branches), et l'intelligence algorithmique unique de GitWand (résolution automatique de conflits) — le tout dans une app native cross-platform (Tauri 2 + Rust).

**Positionnement** : GitWand n'est pas "encore un Git GUI". C'est un client Git qui *comprend* le code, résout les conflits triviaux tout seul, et rend visuel ce que le terminal cache.

---

## Analyse concurrentielle

| Client | Stack | Prix | Forces | Faiblesses |
|--------|-------|------|--------|------------|
| **Kaleidoscope** | macOS natif | ~150€/an | Image diff, folder diff, 3-way merge visuel | macOS-only, pas de workflow Git, pas d'auto-resolve |
| **GitHub Desktop** | Electron | Gratuit | Simple, bon workflow PR, cherry-pick/rebase | Diff basique, résolution rudimentaire, lourd |
| **GitButler** | Tauri/Rust | Gratuit | Virtual branches, stacked PRs, IA intégrée | Nouveau paradigme déroutant, pas d'image/folder diff |
| **GitKraken** | Electron | $5/mois | Graph visuel, merge editor 3-way, Jira/Trello intégrés, Launchpad (PRs+issues cross-repo), Workspaces multi-repo cloud-synced, Cloud Patches, AI partout (commit/PR/merge), Agent Sessions View (Claude Code) | Payant, Electron, lourd, nécessite compte cloud pour les features avancées |
| **Fork** | Natif | $50 | Rapide, interface propre, gros repos | Pas d'auto-resolve, pas d'IA |
| **Tower** | Natif | $69/an | Undo puissant, conflict advisor | Payant, pas d'auto-resolve |
| **Sublime Merge** | Natif | $99 | Ultra-rapide, search puissant | Pas de PR workflow |

**GitWand vs GitButler** : GitButler réinvente le workflow (virtual branches), GitWand améliore le workflow existant avec de l'intelligence (auto-resolve, MCP, suggestions). Même stack Tauri/Rust, audiences complémentaires.

---

## Shipped

### v1.0.0 — Client Git complet + Code Review

Tout le socle d'un client Git quotidien, livré et testé.

**Core — Moteur de résolution**
- 8 patterns de résolution (same_change, one_side_change, delete_no_change, whitespace_only, non_overlapping, value_only_change, generated_file, complex) — LCS 3-way, diff2 + diff3
- Score de confiance composite (`ConfidenceScore` 0–100, dimensions, boosters/penalties)
- Résolveurs par format : JSON/JSONC sémantique, Markdown section-aware, YAML, Vue SFC, CSS/SCSS, TS/JS imports, lockfiles (npm/yarn/pnpm)
- Politiques configurables (`.gitwandrc`) : prefer-ours, prefer-theirs, prefer-safety, prefer-merge, strict — par projet et par glob
- DecisionTrace : trace pas-à-pas, mode explain-only
- Validation post-merge (marqueurs résiduels, syntaxe JSON)
- 332 tests, 20 fixtures corpus, benchmarks (249k ops/s sur 1 conflit)

**Desktop — Interface**
- Repository overview, staging/unstaging (fichier + ligne/hunk), commit (summary + description, Ctrl+Enter, signature)
- Push/pull avec badges ahead/behind, auto-fetch 30s
- Branches : liste locale/remote, création/suppression, switch, merge avec merge editor VS Code-style
- Diff avancé : side-by-side toggle, syntax highlighting (30+ langages), word-level LCS, minimap canvas, hunk navigation, collapse zones inchangées
- History/Log : vue chronologique, diff par commit, scroll-spy, collapse description
- DAG graph : visualisation branches SVG, layout lanes, ref badges
- File history + blame (`--porcelain`) + time-travel diff
- Merge preview : simulation zéro side-effect (merge-base + git show + merge-file -p --diff3)
- Conflict prevention : alerte proactive fichiers en commun entre branches
- Amend commit, cherry-pick (multi-sélection, continue/abort), stash manager
- PR workflow GitHub (créer/lister/checkout/merge via `gh` CLI)
- Repo switcher (récents, pin/unpin), multi-onglets (Cmd+T/W/1..9), monorepo awareness
- Terminal intégré (git-only, autocomplete branches/tags)
- i18n FR/EN type-safe, thème dark/light/system, Settings complet (13 paramètres câblés)
- Raccourci global Cmd+Shift+G / Ctrl+Shift+G

**Code Review intégré (Phase 9)**
- Liste PRs dans sidebar, détail dans zone principale (Info/Diff/CI/Intelligence)
- Commentaires inline : lecture, threads, création par sélection de ligne/plage, suggestions applicables
- Soumission de review : Approve / Request changes / Comment, brouillon accumulé
- Intelligence : conflict prediction (merge-tree), hotspot analysis, review scope, suggestions IA, historique review
- Suggestions IA multi-provider (Claude / OpenAI / Ollama) dans merge editor et review

**Infrastructure**
- CI/CD multi-OS (macOS universal, Linux, Windows)
- Auto-update Tauri updater
- VitePress documentation website

### v1.1.0 — LLM Integration

Ouverture de GitWand aux agents IA via MCP et enrichissement de la sortie CLI.

**MCP Server (`@gitwand/mcp`)**
- 5 tools : `gitwand_status`, `gitwand_resolve_conflicts`, `gitwand_preview_merge`, `gitwand_explain_hunk`, `gitwand_apply_resolution`
- 3 resources : `gitwand://repo/conflicts`, `gitwand://repo/policy`, `gitwand://hunk/{file}/{line}`
- Transport stdio, compatible Claude Code / Claude Desktop / Cursor / Windsurf
- Boucle human ↔ LLM : GitWand auto-resolve les triviaux → LLM résout les complexes via `pendingHunks`

**Claude Code slash commands**
- `/resolve` : workflow complet de résolution
- `/preview` : merge preview et risk assessment

**CLI enrichi**
- `--ci` / `--json` retourne un rapport structuré complet : confidence scores, decision traces, `pendingHunks` avec ours/theirs/base pour chaque hunk non résolu
- Validation post-résolution incluse dans le JSON

**Desktop — Améliorations UX**
- Résolution partielle : le bouton "Résoudre auto" applique les hunks résolvables même quand tous ne le sont pas (`buildPartialContent`)
- Modale de succès merge avec boutons Close (→ dashboard) et Push, thème light/dark via design tokens
- Dashboard : rendu README amélioré (parsing header HTML GitHub, tables GFM, checkboxes, ancres de navigation, gestion images relatives)
- Endpoint `/api/read-gitwandrc` ajouté au dev-server

**Website**
- Page MCP Server dans la documentation VitePress
- Homepage FR/EN avec toggle langue
- Footer mis à jour (2026 Devlint)

**Branding**
- Nouveau logo 3D hexagonal cube (remplace l'ancien magic wand)
- Icônes app Tauri regénérées (ico, icns, png multi-tailles)

### v1.2.0 — Interactive Rebase, Absorb, AI commits & Undo

Productivité du workflow quotidien : opérations Git avancées accessibles, IA dans la zone de commit, filet de sécurité universel.

**Rebase interactif (1.2.1)**
- Drag-and-drop dans le log pour réordonner les commits
- Actions par commit : squash, edit message, drop, fixup
- Squash multi-sélection avec message combiné
- Rebase sur branche depuis l'UI
- Gestion des conflits en cours de rebase (continue/abort/skip)

**Absorb (1.2.2, inspiré GitButler)**
- Clic droit sur fichier modifié → "Absorber dans un commit"
- Détection auto du commit candidat via `git blame`
- Absorb partiel (sélection de hunks) via `useAbsorb.ts`

**AI commit messages (1.2.3)**
- Menu déroulant IA dans la zone de commit → analyse du diff staged → summary + description
- Provider configurable : Claude Code CLI, Claude API, OpenAI-compatible, Ollama
- Régénérer, raccourcir, détailler, changer de langue

**Undo universel (1.2.4)**
- Stack d'opérations GitWand (commit, merge, rebase, cherry-pick, stash, discard…)
- Undo en un clic via `git reset` / `git reflog` selon le cas
- Panel d'historique des opérations avec retour à n'importe quel état

**Autres améliorations**
- Endpoint dev-server `gh-merge-pr` + wrapper TypeScript
- Website : section LLM/MCP et FAQ sur la homepage

### v1.3.0 — AI Everywhere

L'IA s'infuse dans chaque étape du workflow Git (réutilise `useAIProvider.rawPrompt()` et `@gitwand/mcp`). Chaque suggestion reste optionnelle, explicite, et traçable (prompt + provider visibles).

**1.3.1 — AI code review & PR**
- Description de PR auto-générée (`PrCreateView` → titre + body structurés à partir de `currentBranch..base`)
- Critique IA par hunk dans le panneau Review (feedback, risques, régressions, suggestions)
- Suggestion de nom de branche depuis description ou diff staged

**1.3.2 — AI conflict & merge insight**
- Explication de conflit en langage naturel dans le merge editor (traduction du `DecisionTrace`)
- Résumé IA du risque avant rebase/merge (complète la simulation `merge-tree`)
- Exposition desktop de `gitwand_explain_hunk` (MCP)

**1.3.3 — AI commit workflow**
- Message de stash auto depuis le diff unstaged (y compris flow switch-branch)
- Squash sémantique en rebase interactif (groupement par intention + message combiné)
- Classement IA pour Absorb (ranking sémantique quand les lignes couvrent plusieurs commits)

**1.3.4 — AI history & search**
- Recherche de commits en langage naturel dans le `CommitLog`
- Blame contextuel — "pourquoi cette ligne a changé ?" par bloc de blame
- Générateur de release notes / changelog depuis `git log <tag>..<tag>`

**1.3.5 — Tips tournants**
- Encart tip tournant sur la page d'accueil avant sélection de repo (~20 tips FR/EN, rotation 30 s)

### v1.4.0 — Pattern registry & auto-update

Refonte du moteur de classification et outillage desktop de distribution. Livré en même temps que la phase v1.3 dans la release `1.4.0`.

**Core — Pattern registry**
- Pipeline de classification réécrit autour d'un registre priorisé (`priority`, `requires: diff3 | diff2 | both`, `detect`, `confidence`, `explanation`)
- Nouveau résolveur **`reorder_only`** — permutations pures (mêmes lignes, ordre différent), auto-résolu
- Nouveau résolveur **`insertion_at_boundary`** — insertions pures des deux côtés, base intacte, auto-résolu
- Scoring de confiance affiné (boosters, pénalités, garde-fous renforcés sur `complex`)

**Desktop — Distribution**
- Vérification d'auto-update au lancement (GitHub Releases) avec toast + lien changelog
- Affichage de la version courante (footer / About)

**Branding**
- Favicon hex-cube partagé entre l'app desktop et le website

### v1.5.0 — Hardening, performance & English-first

Vague de durcissement : sécurité (XSS, CORS, path traversal), mémoire du moteur de diff, parallélisme côté app + CLI, validation post-merge étendue, et bascule du défaut de locale vers l'anglais. Aucun changement d'API publique — c'est une release de consolidation.

**Sécurité**
- Assainissement XSS sur 10 vues via un composable partagé `useSafeHtml` / `useMarkdown` (DOMPurify + markdown-it)
- Dev-server : CORS restreint et validation de chemin filesystem contre le path traversal

**Moteur — performance**
- LCS mémoire O(n·m) → O(min(n, m)) via approche hybride (Int32Array DP sous 4M cellules, Hirschberg au-dessus) — ~35× sur 3000×3000, tie-break inchangé
- Parallélisation de la lecture des conflits dans l'app (borné)
- Parallélisation de la boucle CLI `gitwand resolve` (borné)

**Extension utilisateur**
- Option `generatedFiles` dans `.gitwandrc` — globs additifs routés vers le résolveur `generated_file`
- Validation post-merge étendue aux formats YAML et TOML (erreurs préfixées `YAML: …` / `TOML: …`)

**Parité Rust ↔ Node**
- Harnais de tests de parité pour 3 commandes Tauri — détecte les dérives entre backend Rust et dev-server Node

**i18n**
- Locale par défaut basculée vers l'anglais (app desktop + website) ; le français reste auto-détecté et maintenu en parallèle

**Internals**
- Split de `resolver.ts` en 6 sous-modules (validation, policy, generated-detection, …)
- Split de `cli/index.ts` en sous-modules par commande
- Retrait de `@types/dompurify` (deprecated — DOMPurify 3.x fournit ses propres types)

### v1.5.1 — Release hotfix & macOS TCC

Patch de release correctif : ship le bundle universel macOS qui échouait au build, calme la boîte de dialogue de permissions macOS qui se déclenchait 50 fois, et termine la migration i18n des messages d'erreur dans les composables.

**CI release**
- `autobins = false` dans `apps/desktop/src-tauri/Cargo.toml` — empêche Cargo d'auto-découvrir `src/bin/parity_probe.rs` comme cible bin non gatée, ce qui brisait le `lipo -create` universel lorsque le binaire existait pour une seule architecture
- Rename `shortcut` → `_shortcut` dans la closure global-shortcut pour éteindre le warning clippy

**macOS TCC (Transparency, Consent, Control)**
- Guard `MACOS_TCC_PROTECTED` sur `list_dir` (Rust) et l'endpoint équivalent dans `dev-server.mjs` — skip le probe `.git` sur `Documents`, `Desktop`, `Downloads`, `Pictures`, `Movies`, `Music`, `Library` lors du listing du home ; ces dossiers ne sont jamais des repos git et leurs enfants déclenchaient TCC en boucle sur les builds ad-hoc non signés

**i18n**
- Migration des messages d'erreur des composables IA (`useCommitMessage`, `useBranchName`, `useReleaseNotes`, `useStashMessage`, `usePrDescription`, `useSquashSuggestion`, `usePrHunkCritique`, `useBlameContext`, `useMergeRisk`, `useCommitSearch`, `useHunkExplanation`, `useAIProvider`) vers le namespace `errors.*` déjà peuplé dans les 5 locales
- Export du helper `t` standalone depuis `useI18n` pour traduire depuis des modules non-composant

### v1.6.1 — Folder diff + MCP Registry & npm ✅

- Folder tree view in commit diff (flat ↔ tree toggle, per-folder aggregates, resizable sidebar, keyboard navigation)
- `@gitwand/mcp`, `@gitwand/cli`, `@gitwand/core` published on npm
- `io.github.devlint/gitwand` indexed on the official MCP Registry

### v1.6.2 — Image diff ✅

- Comparaison visuelle : side-by-side, overlay, blink, slider split
- Formats : PNG, JPEG, SVG, WebP, GIF
- Métadonnées (taille, dimensions, profil couleur), badge animated pour GIF
- Backend `read_file_at_revision` (Rust + dev-server + TS)

### v1.6.3 — Submodules & Worktrees ✅

- Worktree manager : créer, lister, supprimer — chaque worktree dans un onglet
- Checkout rapide via worktree : bouton ⧉ sur chaque branche, ouvre le manager pré-rempli
- Submodule panel : liste avec statuts, init & update, open-in-tab, add — banner warning si non-init
- Auto-update fixes : `createUpdaterArtifacts`, permissions capabilities, signatures réelles dans le manifest

### v1.7.0 — Split commit par hunks ✅

Premier jalon de l'alignement Git 2.54. Découpe d'un commit en deux via sélection ligne-à-ligne, intégré à l'interactive rebase.

**Split commit**
- Nouveau primitif backend `git_split_commit` (3 couches : Rust, dev-server, wrapper TS + composable `useSplitCommit`)
- Modale dédiée avec lignes repliées par défaut (résumé : chevron, nom court, chemin, +/−, hunks, sélection). Clic pour déplier. Sélection préservée au collapse/expand via prop `initialSelection` sur `DiffViewer`. Toolbar "Tout déplier / Tout replier" si > 3 fichiers
- Entrée "Split this commit…" dans le menu contextuel du log + action `split` dans l'interactive rebase (halt synthétique via `edit`, modale préchargée, reprise du rebase à la confirmation)

**Guards & correctness**
- Blocage des merge commits à toutes les entrées (Rust, dev-server, TS, App.vue, menu contextuel désactivé avec tooltip). Raison : `git reset --mixed HEAD^` sur un merge largue silencieusement le second parent et aplatit l'historique
- En-têtes de patch corrects pour fichiers ajoutés / supprimés / renommés (`GitDiff.status` + `oldPath` propagés depuis `git_show`, `patchBuilder` émet `new file mode` + `--- /dev/null`, `deleted file mode` + `+++ /dev/null`, ou `rename from/to`) — corrige `git apply --cached` qui échouait sur les créations/suppressions
- Types de retour rebase : nouveau flag `inProgress` authoritative pour "rebase en cours", `conflict` réservé strictement aux conflits de merge. L'éditeur ne se ferme plus par erreur sur un halt `edit` / `split` synthétique

**i18n**
- 6 clés pour le flux split (`errorMergeCommit`, `filesCount`, `expandAll`, `collapseAll`, `hunksCount`, `linesSelectedSuffix`) traduites dans les 5 locales (en, fr, es, pt-BR, zh-CN)

### v1.8.0 — Design system & modal foundations ✅

Refonte transverse du header et socle d'overlay partagé — prépare le terrain pour la suite de l'alignement Git 2.54 sans repayer la dette d'UI à chaque nouveau flux.

**AppHeader composable**
- `AppHeader.vue` (1654 lignes) découpé en briques sous `components/header/` : `SyncSplitButton`, `BranchSelector`, `BranchMenu`, `SearchTrigger`, `SearchPalette`, `RepoTabStrip` (remplace `RepoTabBar`), `HeaderLogo`, `BranchRenameModal`, `BranchDeleteModal`
- Composable `useSyncAction` + tests (transitions publish / push / pull / fetch / mergeRemote)
- Cmd/Ctrl+K command palette (branches, commits, quick actions)
- i18n des clés `syncAction`, `branchMenu`, `header.searchTooltip` dans les 5 locales (en, fr, es, pt-BR, zh-CN)

**BaseModal + AiSparkle**
- `BaseModal.vue` (367 lignes) : backdrop, focus trap, Esc-to-close, footers typés (primary/danger/ghost), specificity `.bm-btn` pinned à (0,1,0) pour que les modifiers restent composables
- `AiSparkle.vue` (77 lignes) : icône réutilisable pour les actions IA, remplace les SVG inline dispersés
- 10 modales migrées : `EditCommitOverlay`, `MergeSuccessModal`, `PrReviewModal`, `RebaseEditor`, `SettingsPanel`, `SplitCommitModal`, `StashManager`, `BranchRenameModal`, `BranchDeleteModal`, `SearchPalette`

**Backend : renommage de branches**
- Nouveau primitif `git_rename_branch` (Rust + dev-server + wrapper TS), exposé via `useGitRepo.renameBranch`
- Modale dédiée `BranchRenameModal.vue` remplaçant l'inline `rename()` dans `BranchMenu`
- `BranchDeleteModal.vue` avec type-the-name guard pour branches non-merged

**Merge editor — numéros de ligne + minimap**
- Numérotation par ligne sur les panneaux code et conflit
- Minimap canvas à droite : highlight auto-resolvable vs manual pour navigation rapide

**PR — description markdown + switch formatted/raw**
- `PrDetailView` rend la description en markdown complet (tables, code blocks, liens, blockquotes, images) via `renderMarkdown`
- Segmented pill switch "Formatted / Raw" aligné sur le widget readme du Dashboard
- Clés i18n `dashboard.formatted` / `dashboard.raw` dans les 5 locales

**PrIntelligencePanel — refonte**
- Icônes de section (emoji → tuile accent-soft 28px + SVG inline)
- Scope grid en `.pi-stat` cards (icône + label + valeur, radial hover gradient, lift)
- File rows / hotspot rows / AI flag rows unifiés avec `border-left: 3px solid` severity strip
- Banner conflit success/danger, bouton "Analyser" en CTA primaire
- Loading dot-spinner 10px, `@media (prefers-reduced-motion)` désactive transforms + spin

**PrCreateView — polish**
- Icon hero, segmented template pills, bouton AI accent, draft card mise en valeur
- Cohérence visuelle avec `PrDetailView`

**Sidebar & folder picker**
- `RepoSidebar.vue` : padding aéré, icon badges, hover lifts sur branches / activité / quick actions
- `FolderPicker.vue` : historique en chips pill (plutôt que liste verticale)

### v1.9.0 — Suite alignement Git 2.54 ✅

Reste de la veine Git 2.53 / 2.54 — wrapping de commande + UI, pas de changement de philosophie.

**Log — menu contextuel commit ✅**
- Checkout commit (détached HEAD, warning + modal)
- Reset to commit (sélecteur soft/mixed/hard, warning rouge sur --hard)
- Revert commit (non-destructif, merge commits via -m 1)
- Create branch here (git checkout -b \<name\> \<sha\>)
- Tag this commit (lightweight ou annoté)
- Cherry-pick onto current branch
- Amend / Split — HEAD only, guards sur merge commits
- Copy short SHA / Copy full SHA / Copy commit message
- View on GitHub / GitLab / Bitbucket
- 4 nouveaux backends 3-couches (Rust + dev-server + TS), `git_create_branch` étendu avec `start_point`
- 37 clés i18n en parité sur les 5 locales (en/fr/es/pt-BR/zh-CN)

**Trailers ✅**
- Toggles `Signed-off-by` / `Reviewed-by` dans le panneau de commit de la sidebar
- Signed-off-by auto-rempli depuis `git config user.name/email` (chargé eagerly au montage)
- Reviewed-by : checkbox + input texte libre
- Trailers injectés comme bloc séparé (ligne vide + trailers) dans `useGitRepo.commit(trailers)`
- `useCommitMessage.ts` : assouplissement de l'interdiction IA → les trailers restent sous contrôle de l'utilisateur

**Blame diff algorithm ✅**
- Sélecteur `histogram | patience | minimal | myers` dans Settings → onglet Git
- `git_blame` implémenté en Rust (était manquant — seulement dans dev-server), avec flag `--diff-algorithm=<algo>`
- `getGitBlame(cwd, path, algorithm)` mis à jour (backend.ts + dev-server)
- `FileHistoryViewer` lit le setting au moment du chargement du blame
- 3 nouvelles clés i18n × 5 locales

**File history line-range + pickaxe ✅**
- Barre de recherche pickaxe dans l'onglet Historique de `FileHistoryViewer` : mode `-S` (chaîne littérale) et `-G` (regex), résultats filtrés en temps réel
- Bouton 🕐 sur chaque bloc de lignes du blame → `git log -L <start>,<end>:<file>` — bascule automatiquement vers l'onglet Historique avec un bandeau "Historique des lignes X–Y"
- `git_file_log` implémenté en Rust (était manquant), + `git_file_log_pickaxe`, `git_file_log_range` — 3 backends 3-couches
- `displayedLog` computed consolidant les 3 sources (range > pickaxe > log complet)

**Status & forks (triangulaire) ✅**
- `GitStatus` étendu : `push_remote` + `ahead_push` calculés depuis `@{push}` quand il diffère de `@{upstream}`
- Badge "↑N fork" dans `SyncSplitButton` — visible uniquement quand push remote ≠ upstream
- Détection automatique : `git rev-parse --abbrev-ref @{push}` + `git rev-list --count <push_remote>..HEAD`
- Propagation : useGitRepo → App.vue → AppHeader → SyncSplitButton (props `pushRemote` / `aheadPushCount`)

**Tags ✅**
- Panneau "Tags" (bouton ◇ dans la sidebar) : liste locale triée semver, badges annoté/léger, date relative, hash court
- Actions par tag au hover : push vers remote, suppression locale (avec option de supprimer aussi sur remote — confirmation modale)
- "Push all tags" en un clic via `--tags`
- Ref badges branch/tag/remote dans la vue Log list (en plus du DAG) — amber pour les tags, violet pour les branches
- AI tag suggestion : bouton ✦ dans le modal de création → analyse commits depuis le dernier tag, suggère le prochain bump semver + message annoté en une ligne (`useTagSuggestion.ts`)
- Backends 3-couches : `git_list_tags`, `git_delete_tag`, `git_push_tags`, `git_delete_remote_tag`

**Release automation — MCP Registry ✅**
- Job `publish-mcp-registry` ajouté à `publish.yml` : déclenché sur tag `v*.*.*`, après `publish` + `smoke-test`
- Installe `mcp-publisher` via binaire pré-compilé (pas de brew requis sur ubuntu-latest)
- Poll npm jusqu'à 12 min pour garantir la propagation avant de publier sur le registry
- Auth via `secrets.MCP_PUBLISHER_TOKEN` (PAT `read:user`, doc mise à jour dans PUBLISH-TO-REGISTRY.md)

**Commit prefixes — Conventional Commits ✅**
- Chips `feat · fix · docs · chore · refactor · test · style · perf · ci` au-dessus du summary input
- Clic → injecte le préfixe (`feat: …`) et remplace l'existant ; re-clic → retire le préfixe
- `activePrefix` computed détecte le préfixe en temps réel (compatible avec les messages générés par l'IA)

**Post-merge branch cleanup ✅**
- `MergeSuccessModal` propose "Supprimer «branche»" après un merge réussi
- Checkbox "Supprimer aussi sur le remote" → `git push <remote> --delete <branch>`
- `lastMergedBranch` capturé dans `mergeBranch()` et passé en prop au modal

---

## Quick Fixes

_Post-v2.5.0 — à traiter en priorité avant les features v2.x._

### Bugs

- **Recherche globale — stale au changement de repo** : la liste des branches dans la recherche globale n'est pas invalidée quand on change de dépôt. En cliquant sur la recherche, on voit encore les branches du repo précédent. Fix : re-fetcher / réinitialiser le store de recherche lors du changement de repo actif.

- **Liste des PR vide alors que des PR existent** : GitWand ne trouve pas les PR sur certains repos qui en ont pourtant. Vérifier l'appel API (endpoint, auth token, mapping des remotes), logguer l'erreur, ajouter un état d'erreur explicite dans la sidebar PR ("Impossible de charger les PR — vérifier le token GitHub dans les settings").

### UX / Polishing

- **Bouton `+` (nouveau repo) — afficher les repos favoris** : quand on clique sur le `+` en haut de la sidebar, proposer en dessous des actions (Ouvrir / Cloner / Forker) une section "Repos récents / favoris" identique à la page d'accueil, séparée par un `<hr>`. Évite de naviguer vers l'accueil pour rouvrir un repo connu.

- **Push/Sync avec un tag non poussé — demander confirmation** : quand un ou plusieurs tags locaux n'ont pas encore été poussés vers origin, afficher une modale de confirmation avant le push : "Ce repo a N tag(s) non poussé(s) — voulez-vous les inclure ?" avec un bouton "Pousser avec les tags" et "Ignorer les tags".

- **Modale Tags — boutons d'action plus grands** : les boutons "Nouveau tag" et "Pousser tout vers origin" sont trop petits par rapport aux standards des autres actions de l'app. Les aligner en hauteur / padding avec les boutons d'action secondaires du design system.

- **Bouton Rembobiner — fond blanc en Light mode** : dans la liste de l'historique des opérations, le bouton Rembobiner utilise un fond transparent qui ne contraste pas correctement en mode clair. Appliquer `background: white` (ou `var(--color-surface)`) en Light mode.

- **Sidebar PR — filtre "assignées à moi"** : comme pour les commits (filtre auteur), ajouter dans la sidebar PR un filtre rapide pour n'afficher que les PRs assignées à l'utilisateur connecté. Réutiliser le même pattern de composant que le filtre auteur des commits.

- **Bandeau d'erreur rouge — remplacer par un log dans les Settings** : supprimer le bandeau rouge affiché en haut de l'app. À la place : (1) ajouter un onglet **Logs** dans le panneau Settings ; (2) chaque erreur y est loggée sur une ligne `[timestamp] message` ; (3) une icône discrète dans la barre d'état (⚠ ou point rouge) signale qu'il y a des erreurs non lues — clic → ouvre l'onglet Logs.

### Feature — Mode hors-ligne

Quand la connexion internet est absente ou instable, GitWand ne doit pas figer ni afficher des spinners infinis. Toutes les opérations purement locales doivent rester disponibles :

- Navigation dans les commits, les branches, le diff des fichiers, les hunks de conflit
- Résolution de conflits via `@gitwand/core` (synchrone, pas de réseau)
- Visualisation de l'historique, du log, du stash, des tags locaux
- Les opérations réseau (push, pull, fetch, PR, clone) affichent un état "Hors-ligne" clair (icône + tooltip) et sont désactivées — pas de spinner infini
- Détecter la connectivité via `tauri-plugin-network` ou un ping timeout court sur le remote ; basculer automatiquement en mode hors-ligne et revenir dès que la connexion revient (sans redémarrer l'app)
- Documenter les opérations disponibles hors-ligne dans la doc utilisateur

---

## Next — v2.0.0 — Distribution & polish

Fondations cross-platform et quick wins UI avant d'attaquer les grosses features.

**Clone & Fork depuis l'UI ✅**

Deux backends 3-couches (`git_clone`, `gh_fork` — Rust + dev-server + TS) + deux modales (`CloneModal.vue`, `ForkModal.vue`) basées sur `BaseModal`. Trois points d'entrée :

- **Écran d'accueil** ✅ : boutons "Clone from URL" et "Fork on GitHub" en row secondaire sous le primary "Open a repository" — visibles dès le premier lancement
- **Tab strip `+`** ✅ : `RepoTabStrip` convertit en dropdown (click outside / Esc pour fermer) avec trois entrées : Open folder / Clone from URL / Fork on GitHub
- **File menu** ✅ : items Clone… (`⌘⇧O`) et Fork on GitHub… réactivés (étaient différés en v1.9 lors du chantier menu bar)
- **Clone** ✅ : URL Git (HTTPS ou SSH), parent dir picker, dest = `<parent>/<repo-name>` auto-dérivé. Spinner + libellé "Cloning…" pendant l'opération, ouverture auto dans GitWand au succès
- **Fork** ✅ : URL repo GitHub, parent dir picker, dest auto-dérivé. Backend = `gh repo fork <url> --clone --remote-name=upstream`, donc `origin` = ton fork, `upstream` = le repo d'origine, prêt pour PR upstream
- **i18n** ✅ : 25 nouvelles clés × 5 locales (`clone.*`, `fork.*`, `header.tabStrip*`, `empty.{clone,fork}Button`, `menu.{clone,fork}`)

_Différé (polish)_ : pas de barre de progression temps-réel pendant le clone — `git_clone` est synchrone côté Rust + dev-server (aucun event Tauri/SSE introduit). Le spinner suffit pour les clones courants. Pour ajouter le progress, il faudrait introduire un primitif async + emit Tauri (`window.emit("git-clone-progress", …)`) + écouteur côté TS. Chantier en soi, à reprendre quand on aura un autre flux long-running (fetch sur gros monorepo, etc.).

**AI providers — Codex CLI ✅**

- **Codex CLI ✅** : provider `codex-cli` ajouté à `useAIProvider.ts` (union, dispatcher `suggest()` + `rawPrompt()`, optimistic `isAvailable`). Backend 3-couches : `resolve_codex_binary` (PATH + npm install paths), `detect_codex_cli` (version + ping `codex exec --quiet ping` qui surface auth status), `codex_cli_prompt` (Rust + dev-server). Settings > AI : option dans le dropdown, status block (detecting / not_found / not_logged_in / connected) miroir de celui de Claude CLI, info-box explicative. Détection auto au mount pour griser l'option si non installé. 5 nouvelles clés i18n × 5 locales. Auth via `codex login` (abonnement ChatGPT) ou `OPENAI_API_KEY`.
- Le provider "OpenAI-compatible" existant couvre déjà l'API OpenAI directe (`gpt-4o`, `o3`…) — pas de changement nécessaire de ce côté
- **AIProvider type unifié** : `SettingsPanel.vue` redéclarait inline le type union (avec un drift facile) — replacé par un import depuis `useAIProvider`, single source of truth. Re-export depuis `SettingsPanel` pour ne pas casser les éventuels consommateurs

_Différés_ :
- **Gemini CLI** : reporté jusqu'à stabilisation du mode non-interactif Google (`gemini --quiet "..."` sans REPL hang). Dès que c'est stable, mêmes 3 couches que Codex à recopier
- **MCP compatibility matrix** : déplacé dans le chantier v2.8 (Agent Sessions View) où il s'aligne naturellement — adapter le panel pour détecter Cursor / Windsurf / Codex CLI / etc. en plus de Claude Code, plus tester + documenter officiellement la compat de `@gitwand/mcp` avec chaque client

**Distribution & signing**
- ✅ Signature macOS (Developer ID + notarization Apple) — v1.9.0
- ✅ Auto-update channel (stable / beta) — `Settings.updateChannel` + `fetchBetaUpdate(currentVersion)` (manual fetch sur `latest-beta.json` + comparaison semver locale). Stable garde le path Tauri plugin (auto-install in-app), beta passe en mode "manual" : `UpdateModal` montre le même flux mais le bouton ouvre la GitHub release page au lieu de remplacer le binaire. Choix dicté par la limitation Tauri 2 (pas de runtime endpoint override sur `tauri-plugin-updater`). 15 nouvelles clés i18n (5 settings + namespace `update.*` 10) × 5 locales. _TODO infra_ : adapter le workflow GitHub Actions de release pour publier `latest-beta.json` quand le tag matche `v*-beta.*`
- Signature Windows (Authenticode)
- Homebrew cask, winget, Flatpak

**Barre de menu macOS native ✅**

Menus File / Edit / Repository / View / Window / Help construits côté JS via `@tauri-apps/api/menu` — labels tirés de `useI18n()`, rebuild atomique sur changement de locale ou ouverture/fermeture de repo. Composable `useAppMenu.ts`, gating macOS via `navigator.platform`. 22 clés `menu.*` × 5 locales. No-op sur Linux/Windows (l'`AppHeader` porte la chrome ailleurs).

- **GitWand (app menu) ✅** : About, Settings… `⌘,`, Services, Hide / Hide Others / Show All, Quit (predefined macOS items + Settings custom)
- **File ✅** : Open Repository… `⌘O`, Open Recent (sous-menu peuplé depuis `useFolderHistory`, max 10 + Clear), Close Window `⌘W` (close active tab — sémantique GitWand, pas l'OS window)
- **Edit ✅** : Cut `⌘X`, Copy `⌘C`, Paste `⌘V`, Select All `⌘A` — predefined items, routent vers le first-responder natif. Cmd+Z laissé webview-default pour préserver le text-undo dans les inputs.
- **Repository ✅** _(disabled si pas de repo ouvert)_ : Fetch `⌘⇧F`, Pull, Push `⌘P`, New Branch… `⌘⇧B` (provide/inject bridge `BRANCH_CREATE_REQUEST_KEY` → ouvre le popover + le formulaire inline de `BranchSelector`, autofocus natif sur l'input), Open on GitHub / GitLab / Bitbucket (auto-détection via `gitRemoteInfo`)
- **View ✅** : Toggle Light/Dark Mode `⌘⇧T`, Enter Full Screen `⌃⌘F` (predefined)
- **Window ✅** : Minimize `⌘M`, Zoom, + window list auto via `setAsWindowsMenuForNSApp()`
- **Help ✅** : GitWand Documentation (gitwand.devlint.fr), What's New (GitHub Releases), Report an Issue (GitHub Issues), Check for Updates… (branché sur `runUpdateCheck()`). Search box auto via `setAsHelpMenuForNSApp()`.

_Différés à l'origine, repris dans des chantiers ultérieurs_ :
- ~~Clone… / Fork…~~ ✅ chantier Clone & Fork v2.0.0 (items réactivés dans `useAppMenu.ts`, `⌘⇧O` pour Clone…)
- ~~Find in Log `⌘F`~~ ✅ provide/inject `LOG_FOCUS_SEARCH_KEY` — bump du counter switche le viewMode sur "history" puis focus l'input `searchQuery` existant de `CommitLog` (qui était déjà câblé pour la recherche locale + IA)
- ~~Merge…~~ ✅ provide/inject `MERGE_POPOVER_REQUEST_KEY` — `AppHeader` watch et appelle `openMergePopover()` (déjà existant, déclenché par `BranchMenu`)
- ~~Open in Terminal `⌘⇧T`~~ ✅ `GitTerminal` rendu dans une overlay réutilisant le shell `stash-overlay`, ouvert via `showTerminal` ref
- ~~Toggle Sidebar `⌘⇧S`~~ ✅ ref `showSidebar` (default true), `<aside class="sidebar" v-if="hasRepo && showSidebar">`
- ~~Undo/Redo sur l'undo stack~~ ✅ découplé du `Cmd+Z` (qui reste sur le text-undo webview natif) — assigné à `⌘⇧U` qui ouvre le popover undo existant via `UNDO_POPOVER_REQUEST_KEY`. Pattern miroir de Merge

_Effets de bord_ : `Toggle Light/Dark Mode` perd son raccourci `⌘⇧T` (récupéré par Open in Terminal per spec). Reste accessible via le menu sans accélérateur, et la chip dans le header est l'entrée primaire.

**Dashboard — Contributors amélioré ✅**

Backend 3-couches `git_shortlog` (Rust + dev-server + TS wrapper `getGitShortlog`) qui wrap `git shortlog -sne HEAD` et parse `<count>\t<name> <email>` en `{ name, email, count }[]`. Frontend (`DashboardView.vue`) :

- **Stats globales ✅** : `allContributors` ref alimenté depuis le shortlog full-history. `contributorCount` passe de `ref(0)` à `computed(() => allContributors.value.length)` — plus accurate qu'agréger une fenêtre de 250 commits
- **Tous les contributeurs ✅** : `topContributors` ne slice plus, attache juste un `pct` (relatif au top contributor) à chaque entrée pour la barre
- **Layout horizontal scrollable ✅** : `.contributors-scroll` en `flex-row` avec `overflow-x: auto`, `scroll-snap-type: x mandatory`, `scroll-snap-align: start` sur chaque carte. Largeur par carte = `(100% - 2×gap)/3` (3 visibles, le 4ème peeke), `min-width: 180px` pour ne pas écraser les noms longs
- **Compact ✅** : carte = grid `28px 1fr auto` (avatar | nom+barre | count) avec border + bg, hover qui passe en `--color-accent-soft`. Stack d'avatars dans la stat card reste à `slice(0, 4)` (effet visuel pile, pas du data display)

---

## v2.x — Roadmap

> **Pivot dual-track** : la suite immédiate du produit s'organise sur deux pistes parallèles.
>
> 1. **Core engine sequence** (`@gitwand/core` v2.1 → v2.6) — séquence prioritaire qui rapatrie l'état de l'art de la résolution automatique de conflits Git (Histogram diff → tree-sitter structural merge → validation sémantique → LLM fallback opt-in → refactoring-aware). Détail dans [CORE-V2-ROADMAP.md](./CORE-V2-ROADMAP.md). Publiée via `workflow_dispatch` sans aligner desktop/cli/mcp, sauf v2.5 (tie-in desktop).
> 2. **Desktop product track** (v2.7 → v2.12) — fonctionnalités desktop renumérotées pour faire de la place au chantier core. Workspaces, Agent Sessions, Launchpad, intégrations forge, performance, Voice Input. Aucune entrée n'est annulée — seule la cadence est ralentie le temps du chantier core.
>
> Chaque jalon des deux tracks est livrable indépendamment.

---

### Core engine — v2 sequence (priority track)

Six releases minor de `@gitwand/core` détaillées dans [CORE-V2-ROADMAP.md](./CORE-V2-ROADMAP.md). Effort total estimé ~15-20 semaines, livrable continu. Chaque release accompagnée d'un article de blog (plan éditorial dans le doc dédié).

**`@gitwand/core@2.1.0` — Histogram diff & block-move detection ✅**

Bascule du backend diff de LCS pur vers Histogram (Patience++ avec ancres rares). `lcs()` garde sa signature publique, `GITWAND_DIFF=lcs` pour rollback. Block-move detection via rolling hash Rabin-Karp, prépare le terrain pour v2.6. **+2-5 %** d'auto-résolution globale attendus, plus sur les cas avec refactor partiel.

**`@gitwand/core@2.2.0` — Format profile registry + JSON Patch arrays ✅**

Résout le trou des tableaux JSON (`/dependencies`, `/scripts`, `tsconfig#/include`) qui retombaient en fallback textuel. Registre de profils par fichier (`package.json`, `tsconfig`, `helm/values`, Kubernetes Deployment…) avec stratégies par chemin JSON Pointer (`set` / `ordered-list` / `merge-keys`). RFC 6902 maison pour les opérations atomiques. **+10-15 %** d'auto-résolution sur les fichiers JSON/YAML monorepo.

**`@gitwand/core@2.3.0` — Tree-sitter structural dispatcher (TS/JS/Python/Go/Rust)** ✅

Le grand saut. Merge entité-par-entité aligné Mergiraf/Weave : parse base/ours/theirs avec `web-tree-sitter`, apparie les entités top-level (fonctions, classes, méthodes, top-level statements) par signature canonique, fusionne entité-par-entité. Grammars en `optionalDependencies` avec WASM lazy-loaded. Adapter pattern pour le chargement Node / browser / Tauri. **+20-30 %** d'auto-résolution sur les conflits TS/JS/Python/Go/Rust.

**`@gitwand/core@2.4.1` — Validation sémantique post-merge ✅**

Livré comme `2.4.1` (resync `cli`/`mcp` qui étaient restés à 2.3.0). Étend `validateMergedContent` avec une couche parse-tree validity multi-langage via tree-sitter (`validate-parse-tree.ts`) ; `tsc --noEmit` et `eslint` deviennent opt-in via `.gitwandrc` (`validation.level: "strict"`, nouveau tier en plus de `off` et `balanced`). `ValidationLevel` renomme l'ancien `standard` → `balanced`. `ValidationResult` expose `parseTreeErrors` + `parseTreeErrorRanges`, et `strictErrors` est remplacé par un `ExternalValidationResult { tool, errors, passed }` typé. Nouvelle dimension `postMergeRisk` dans `makeScore()` (poids −0.20) qui retire rétroactivement les résolutions dont le résultat ne parse plus. `resolveAsync()` populate `externalValidation` sur tous les return paths. +5 fixtures corpus (F31–F35), 2 nouvelles suites de tests (`v2-core-scenarios.test.ts` 829 lignes, `validation-parse-tree.test.ts` 274 lignes). **841/841 tests passing.** Cible roadmap −50 % de faux positifs parse-tree-cassé atteinte.

**`@gitwand/core@2.5.0` — LLM fallback opt-in via MCP ✅** _(tag aligné — desktop tie-in)_

Pattern `llm_proposed` priorité 998, **désactivé par défaut**. Sérialise le hunk + DecisionTrace partielle + contexte ±50 lignes, appelle un endpoint injecté par le consommateur (MCP server externe / API / custom), valide agressivement contre la pipeline v2.4 avant acceptation. Audit trail complet (modèle, hash du prompt, score de validation), `temperature: 0` pour reproductibilité. Nouveau `resolveAsync()` exporté côte à côte avec `resolve()` synchrone. **+10-20 %** global avec LLM activé, 0 % sans (rétro-compat stricte).

**Tie-in livré (cf. [PLAN-v2.5-tie-in.md](./PLAN-v2.5-tie-in.md))** :

- **Desktop** : section "AI fallback" dans `SettingsPanel.vue` (toggle + provider picker + seuils), persistance `.gitwandrc` via nouvelle commande `write_gitwandrc` (3-layer Rust + dev-server + TS), wiring `useGitWand` ↔ `useAIProvider.toLlmEndpoint()`, composant `LlmTracePanel.vue` (audit + bouton Reject) intégré au `MergeEditor.vue` quand `decision.type === "llm_proposed"`, ~80 entrées i18n (16 clés × 5 locales)
- **CLI** : flag `--llm-fallback --llm-provider {claude,openai,ollama}`, endpoint Node `fetch` natif (zéro dep), `--json` enrichi avec `llmTrace`, 13 tests unitaires endpoint, garde rétro-compat stricte sans flag
- **MCP** : tool `gitwand_resolve_hunk` exposé par `@gitwand/mcp` (inversion de boucle : l'agent connecté répond, pas le serveur)
- **Docs** : page `website/guide/llm-fallback.md` (sécurité, providers, coût, audit, FAQ) + article blog `v2-5-llm-fallback.md`
- **Validation** : bench ConGra-mini 15 fixtures (TS/Python/Go/Rust/JSON/Markdown), **15/15 = 100 % résolus** (cible ≥80 % atteinte), 4 scénarios d'intégration desktop ↔ core (happy path, rejet, disabled, provider missing). **901 tests core + 76 tests desktop verts.**

**`@gitwand/core@2.6.0` — Refactoring-aware merge (expérimental) ✅**

Détection de 3 refactorings cibles — rename local, rename top-level, move method — via tokenisation et substitution bijective simultanée (avec recherche par permutation pour les groupes ambigus de même count). Pipeline RefMerge invert/merge/replay (Ellis et al. TSE 2023). Opt-in via `refactoringAware.enabled: true`. Pattern plugin priorité 970, désactivé par défaut. Cache module-level pour éviter le double calcul detect+assemble. Couvre la classe « rename d'un symbole d'un côté + ajout d'un usage de l'ancien nom ailleurs » qu'aucun merge syntaxique ne résout. **898/898 tests passing. +5 %** sur les cas spécifiques de rename, sinon stable.

---

### Desktop product track (v2.7 → v2.12, parallel)

Renuméroté pour faire de la place à la séquence core ci-dessus. Cadence ralentie le temps du chantier. Aucune fonctionnalité n'est annulée.

---

### ✅ v2.7.0 — Workspaces + Hooks manager + Worktree first-class

Fondations multi-repo (prérequis pour le Launchpad), pouvoir utilisateur avancé, et worktrees élevés au rang de primitive workflow.

**Workspaces multi-repo (local)**

Version locale du concept GitKraken Workspaces — sans cloud, sans compte, juste un fichier `.gitwand-workspace.json` commitable.

- Grouper plusieurs repos dans un workspace nommé (par projet, par client, par squad)
- **Actions groupées** : fetch all, pull all, status all en un clic
- Ouvrir tous les repos du workspace d'un coup dans des onglets GitWand
- Launchpad filtré par workspace (prépare v2.9)

**Hooks manager**

- Panneau "Hooks" : liste (`git hook list`), enable / disable (`hook.<name>.enabled`)
- Création de hooks en config (format `[hook "name"] event/command` Git 2.54), avec multiple hooks par event
- Partage cross-repo via `~/.gitconfig` (vs copie dans chaque `$GIT_DIR/hooks`)
- Cohérent avec la philosophie "rendre visuel ce que le terminal cache"

**Worktree first-class UI** _(Codexia-inspired — upgrade de v1.6.3)_

Le manager worktree de v1.6.3 crée / liste / supprime. Ici on passe au paradigme "une tâche = un worktree" en faisant des worktrees une unité de navigation à part entière de l'app :

- **Tab = worktree** : chaque worktree peut s'ouvrir dans un onglet GitWand indépendant (diff, log, staging) — pas de navigation back/forth ; coexistence visuelle immédiate
- **Quick-create "New task"** : raccourci `⌘⇧N` → saisir un nom de tâche → crée un worktree + branche en un seul geste, l'ouvre dans un nouvel onglet
- **Status cross-worktrees** : bandeau dans le workspace panel montrant tous les worktrees du repo courant — branche, ahead/behind, fichiers modifiés — d'un coup d'œil (prépare v2.8 Agent Sessions)
- **Cleanup assisté** : détection des worktrees dont la branche a été mergée — proposition de suppression groupée depuis le manager
- **Intégration workspace** : les worktrees d'un repo sont listés dans le workspace panel (v2.7 Workspaces ci-dessus) comme entités de premier niveau

---

### ✅ v2.8.2 — Performance hardening

Vague de durcissement perf après diagnostic d'une régression de fluidité v2.6 → v2.8. ~30 chantiers livrés sur les 6 niveaux d'optimisation (UI, polling, backend Rust, bundle, mesures, structure du code). Voir [PERFORMANCE_PLAN.md](./PERFORMANCE_PLAN.md) pour le détail chantier-par-chantier.

**Frontend — démarrage & rendu**

- **Lazy-load 20 panels et modaux** (§1.2) via `defineAsyncComponent` — Settings, Stash, Merge editor, Rebase editor, Split commit, Branch rename/delete, PR Review, PR Create, Tags, Hooks, Worktrees, Submodules, Agent Sessions, Launchpad, Workspaces… découpés en chunks Vite séparés. Le bundle initial parsé au cold start est divisé d'autant.
- **Lazy-load 17 langages highlight.js** (§4.3) — seuls 9 langages courants restent dans le bundle principal, les autres (Rust, Go, Python, Java, SQL…) en chunks dynamic-import à la première utilisation. ~150-250 KB gzipped retirés du cold start.
- **Lazy-load badges README** (§1.5) — `loading="lazy"`, `decoding="async"`, `referrerpolicy="no-referrer"` sur les images externes du Dashboard pour ne plus bloquer le rendu.
- **Cache 2-couches du syntax highlighting** (R2) — `_hlCache` dans `highlight.ts` (content + langue) + `_dvHlCache` dans `DiffViewer.vue` (content + langue → safeHtml-ready). DiffViewer ne re-tokenise plus à chaque tick reactivity.
- **Single-pass wordDiff** (R3) — `_diffPaired` computed unique qui produit en une passe `sbsByHunk` (SBS mode) ET `inlineMap` (inline mode). Avant : deux passes indépendantes appelaient `wordDiff()` chacune sur les mêmes paires.
- **CommitGraph deep-equality + viewport culling** (R6) — comparaison de props fine, rendu limité à la fenêtre visible.
- **SearchPalette debounce 150ms** (R5) — plus de tempête de recalculs sur frappe rapide.

**Polling & IPC**

- **useRepoPoller consolidé** (§2.1) — un seul timer App.vue avec callbacks `onStatusChange`, `onConflictDetected`, `onFetchTick`, `onNightlyTick`. Remplace les 3 timers indépendants antérieurs.
- **Pause sur `visibilitychange`** (§2.2) — quand l'onglet GitWand passe en arrière-plan, le polling s'arrête. Reprise immédiate au refocus.
- **Rebase poll conditionnel** (§1.1) — le timer 3 s de détection rebase ne tourne que pendant un rebase, pas en permanence. Cause directe identifiée de la régression v2.6 → v2.8.
- **`tauriInvoke()` timeout par défaut 30 s** (R1) — presets `IPC_TIMEOUT.NETWORK` (5 min pour push/pull/fetch/clone) et `IPC_TIMEOUT.NONE` (AI prompts arbitrairement longs). Plus de Promise IPC bloquante indéfinie.

**Backend Rust**

- **`Cargo profile.release` tuné** (§3.1) — `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`. Build release réduit, exécution accélérée.
- **`workspace_*_all` parallélisés** (§3.2) — `status_all`, `fetch_all`, `pull_all`, `wip_all`, `prs_all`, `issues_all` passent en `rayon::par_iter` ; N repos = N tâches en parallèle (borné aux cores).
- **libgit2 sur `git_status`** (§3.3b) — fast-path in-process via `git2::Repository::open`. Fallback CLI préservé pour les edge cases (partial clones, configs exotiques). Mesure CLI 41 ms → libgit2 32 ms via probe externe ; extrapolation 2-3× dans l'app (sans overhead fork-exec).
- **libgit2 sur `workspace_*_all`** (§3.3a) — branch ahead/behind, modified count, WIP status, last commit timestamp en in-process.
- **Cache `.git` dir résolu** (§2.3) — `resolve_git_dir` mémoïse `git rev-parse --git-dir` par cwd. Plus de re-fork à chaque poll.
- **Truncation défensive `git_diff`** (§2.4) — limite 5 MB par fichier, coupe au dernier `\n` pour ne pas casser un hunk header. Champ `truncated_from_bytes` exposé au frontend.
- **Bump `git2` 0.19 → 0.20.4** — corrige la GHSA `libgit2-sys` 0.17 → 0.18.4+1.9.3.
- **Fix Windows `CREATE_NO_WINDOW`** (#6.a) — réimport du trait `CommandExt` dans `git/cmd.rs` après le split §3.4 : `creation_flags()` redevient effectif, plus de flash de terminal sur Windows.

**Architecture backend — split de lib.rs (§3.4)**

`apps/desktop/src-tauri/src/lib.rs` part de ~3 254 lignes et termine à ~670. Le reste est éclaté par domaine :

```
commands/
  ├── ai.rs        384   Claude + Codex CLI (detect/prompt/login)
  ├── files.rs     272   read_file / write_file / read_file_at_revision / folder_diff / list_dir
  ├── gh.rs        360   gh_issue_* + gh_pr_* (8 commandes)
  ├── ops.rs      2193   stage/unstage/commit/push/pull/merge/rebase/discard
  ├── read.rs     1187   git_status (libgit2 + fallback CLI) / git_diff / git_log / git_repo_state /
  │                      git_show / git_blame / git_file_log* / preview_merge
  └── workspace.rs 268   workspace_read/write + 6 *_all aggregates
git/
  ├── cmd.rs       159   git_cmd() + hidden_cmd() + safe_repo_path + git_changed_files
  ├── libgit2.rs   168   helpers libgit2 partagés
  └── parse.rs     638   porcelain v2 + gh JSON parsers + folder_diff
types.rs           690   structs partagées (rapatriement de l'app)
```

Les wrappers `pub fn *_parity` (consommés par `examples/parity_probe.rs` pour les tests Rust ↔ Node) restent dans `lib.rs` et délèguent vers `commands::read::*`. Refactor à coût zéro sur l'IPC public : les noms de commandes Tauri sont inchangés.

**Mesures & CI**

- **Bench suite** (§6.1) — `apps/desktop/perf/bench.mjs` mesure CLI vs libgit2 sur fixture déterministe ; colonne "vs CLI" affichant le delta.
- **Bundle size budget en CI** (§6.2) — `apps/desktop/scripts/bundle-budget.mjs` casse le build si la taille initiale du JS dépasse le seuil. Évite les régressions silencieuses post-merge.
- **Probe `git-status-fast`** dans `parity_probe` — bench libgit2 isolé, sans masquage par le fallback CLI.
- **`AGENTS.md` enrichi** (§6.4) — invariants perf documentés pour les futurs chantiers (cf. CLAUDE.md `polling discipline`, `tauri-bundler [[example]]` rule, etc.).

**Fix de stabilité**

- **TDZ `CommitLog.vue`** — `watch(() => rows.value.length, ..., { immediate: true })` était déclaré AVANT ses sources transitives ; déplacé sous les déclarations pour éviter le `ReferenceError` au premier render. Pattern documenté en mémoire pour les futures sessions.
- **AI CLI ping désactivé au boot** (#6.b) — `detect_claude_cli` / `detect_codex_cli` ne lancent plus de prompt-ping non sollicité à l'ouverture du SettingsPanel. Statut `detected` ajouté ; le prompt réel n'est tenté qu'à l'utilisation explicite.

---

### ✅ v2.8.0 — Agent Sessions View + Scheduled AI tasks

Réponse directe au lancement GitKraken d'avril 2026 — GitWand peut aller plus loin grâce à `@gitwand/mcp` déjà indexé sur le MCP Registry officiel. Complété par une couche d'automatisation IA planifiée.

**Agent Sessions View**

- **Panel "Agents"** dans la sidebar : liste les sessions MCP actives (Claude Code, Cursor, Windsurf…) travaillant sur les worktrees du repo courant
- Chaque carte : worktree associé, branche, statut (ahead/behind, uncommitted changes), outil agent détecté
- **Intégration worktree** : ouvrir le worktree d'un agent en un clic dans un onglet GitWand — voir son diff en live (s'appuie sur le status cross-worktrees de v2.7)
- **Lancer une session** : raccourci pour démarrer Claude Code (`claude`) sur un worktree vierge depuis GitWand directement
- Complète le MCP server existant : les agents voient GitWand, GitWand voit les agents

**Scheduled AI tasks** _(Codexia-inspired)_

Couche d'automatisation légère : des tâches IA récurrentes déclenchées par un événement Git ou une heure, sans intervention manuelle. Chaque tâche est opt-in, configurable par repo, journalisée dans l'onglet Logs (v2.5 Quick Fix).

- **Tâches prédéfinies** :
  - _Auto-resolve on merge/rebase_ : dès qu'un conflit est détecté, lancer `gitwand_resolve_conflicts` automatiquement, notifier les résultats en toast
  - _Nightly pull + rebase_ : `git pull --rebase` à heure configurée sur les repos du workspace — résolution auto des triviaux, alerte si complexes
  - _Release notes on tag_ : quand un tag `v*.*.*` est créé, générer et enregistrer les release notes dans un fichier (`CHANGELOG.md`) via `useReleaseNotes`
  - _AI commit batch_ : pour un ensemble de fichiers staged en fin de journée, proposer un message de commit AI avant la fermeture de l'app
- **Scheduler UI** dans Settings > Automatisations : liste des tâches, toggle, heure ou événement déclencheur, dernière exécution, journal compact
- **Implémentation** : pas de daemon externe — utilise les lifecycle hooks Tauri (app focus/blur, window close) + un timer tick côté TS pour les tâches horaires. Les tâches réseau restent désactivées si `offline` (voir Quick Fix Mode hors-ligne)

---

### v2.9.0 — Launchpad

_Dépend de v2.7.0 (Workspaces)._ Inspiré du Launchpad GitKraken, mais local-first (pas de cloud requis) : tableau de bord unique agrégeant PRs, issues et WIPs sur tous les repos du workspace.

- **PRs cross-repo** : liste unifiée de toutes les PRs ouvertes sur les repos dans le workspace (via `gh` CLI), avec statuts CI, reviewers, labels — sans ouvrir chaque repo un par un
- **Issues cross-repo** : GitHub Issues agrégées (filtres : assignées à moi, mentionné, créées par moi)
- **WIP panel** : liste des repos avec des changements non commités ou branches en retard — une vue "qu'est-ce qui m'attend" en un coup d'œil
- **Pin / snooze** : épingler une PR importante en haut, snoozer une issue pour la semaine prochaine
- **Vue Équipe** (optionnelle) : ce que les autres font sur les mêmes repos (via l'API GitHub), pour détecter les chevauchements avant qu'ils deviennent des conflits

---

### v2.10.0 — Intégrations forge + MCP catalog

Ouvre GitWand aux utilisateurs non-GitHub, et à l'écosystème MCP grandissant.

**Forge integrations**

- GitLab MRs : API REST/GraphQL native (lister, reviewer, merger)
- Bitbucket PRs : Support Bitbucket Cloud
- Multi-compte GitHub/GitLab (personnel + pro)
- Draft PR convert depuis l'app

**MCP catalog in-app** _(Codexia-inspired)_

Rend l'écosystème MCP Registry directement navigable depuis GitWand — sans passer par un terminal ou une page web.

- **Onglet "MCP" dans Settings** : liste des serveurs MCP disponibles sur le registry officiel (recherche, catégories, étoiles)
- **One-click install** : ajouter un serveur MCP à la config Claude Code / Cursor / Windsurf depuis GitWand — génère ou met à jour le `.mcp.json` / `claude_desktop_config.json` cible
- **Installed vs available** : différencie clairement ce qui est déjà configuré vs ce qui peut être ajouté ; badge "Official" pour les serveurs indexés sur le MCP Registry
- **`@gitwand/mcp` en vedette** : la carte GitWand est épinglée en haut avec statut de connexion live, version, et raccourci "Reconfigurer"
- **Implémentation** : appels à l'API publique du MCP Registry (même endpoint que `mcp-publisher`) via `fetch` côté Tauri — pas de serveur proxy intermédiaire

---

### v2.11.0 — Performance à grande échelle

- Partial clone / sparse checkout pour monorepos massifs — hydratation à la demande via `git backfill <rev> <pathspec>` (scope par range de commits + pathspec wildcards, praticable depuis 2.54)
- Pagination lazy du log sur repos 100k+ commits
- Background indexing pour la recherche dans les commits

---

### v2.12.0 — Voice Input (expérimental)

Inspiré de Gitux, mais intégré au pipeline IA GitWand existant plutôt qu'en silo.

- **Dictée locale** : bouton microphone dans le panneau de commit, capture audio → transcription via un modèle Whisper embarqué (whisper-rs côté Rust) — zéro cloud, zéro réseau
- **Enrichissement IA optionnel** : après transcription, proposer de passer le texte dicté dans `useAIProvider` pour correction grammaticale / conventional commit formatting — GitWand fait mieux que Gitux sur ce point
- **Modèles au choix** : `tiny` (rapide, léger) ou `base` (meilleure précision) téléchargés à la demande via Settings, stockés localement
- **Multilingue** : Whisper détecte automatiquement la langue — utile pour les équipes mixtes FR/EN
- **Fallback gracieux** : si l'accès micro est refusé par macOS TCC, message d'erreur clair avec lien vers Préférences système

---

## Principes de design

1. **Intelligence d'abord** — Chaque écran doit apporter plus que le terminal. Si l'UI ne fait que wrapper `git status`, elle ne sert à rien.
2. **Performance native** — Tauri 2 + Rust. Démarrage < 1s, fluide sur 100k+ commits.
3. **Progressif** — Fonctionne immédiatement pour les cas simples. Les features avancées se découvrent naturellement.
4. **Cross-platform** — macOS, Linux, Windows. Même qualité partout.
5. **Gratuit et open-source** — Core et desktop MIT. Possible freemium team/pro plus tard.

---

## Dépendances techniques

| Feature | Dépendance |
|---------|------------|
| Résolveurs par format | Parseurs légers : `JSON.parse`, YAML, imports TS/JS, PostCSS |
| Image diff | Canvas API frontend + lib Rust pixel diff |
| MCP Server | `@modelcontextprotocol/sdk`, transport stdio |
| PR workflow | `gh` CLI (GitHub), API REST/GraphQL (GitLab/Bitbucket) |
| Suggestions IA | `useAIProvider.ts` — Claude API, OpenAI-compatible, Ollama |
| Terminal intégré | Commande Rust `git_exec` sécurisée |
| Auto-update | `tauri-plugin-updater` + GitHub Releases |
| i18n | Système maison : locales TypeScript typées + `useI18n()` |

---

## Sources

- [Kaleidoscope — Git Diff and Merge Tool](https://kaleidoscope.app/)
- [GitHub Desktop — About](https://docs.github.com/en/desktop/overview/about-github-desktop)
- [GitButler — Virtual Branches & Stacked PRs](https://docs.gitbutler.com/)
- [Git Tower — Release notes](https://www.git-tower.com/release-notes)
- [Best Git GUI Clients 2026](https://lithiumgit.com/most-popular-git-gui-clients)
- [GitKraken Desktop Features](https://www.gitkraken.com/git-client)
- [GitKraken Launchpad](https://www.gitkraken.com/features/launchpad)
- [GitKraken Workspaces](https://www.gitkraken.com/features/workspaces)
- [GitKraken Conflict Prevention](https://help.gitkraken.com/gitkraken-desktop/conflict-prevention/)
- [GitKraken Agent Sessions View — avril 2026](https://help.gitkraken.com/gitkraken-desktop/experimental-features/)

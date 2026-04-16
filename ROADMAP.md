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
| **GitKraken** | Electron | $5/mois | Graph visuel, merge editor 3-way, Jira intégré | Payant, Electron |
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

### v1.2.0 — Interactive Rebase, Absorb, AI commits & Undo (current)

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

---

## Now — v1.3.0 — AI Everywhere

L'IA n'est plus cantonnée au merge editor et au commit message : elle s'infuse dans chaque étape du workflow Git. On réutilise la plomberie existante (`useAIProvider.rawPrompt()`, `@gitwand/mcp`) pour ajouter de l'intelligence là où elle apporte un gain mesurable.

**Principe** : chaque suggestion IA reste optionnelle, explicite (bouton ou raccourci), et traçable (l'utilisateur voit le prompt et le provider utilisé).

### 1.3.1 — AI code review & PR

- **Description de PR auto-générée** : bouton dans `PrCreateView` → analyse des commits du diff (`currentBranch..base`) → titre + body structurés (summary, test plan, breaking changes)
- **Critique IA par hunk dans le panneau Review** : le `PrIntelligencePanel` passe de "analyse statique" à "feedback IA par hunk" (risques, régressions potentielles, suggestions concrètes)
- **Suggestion de nom de branche** : depuis une description ou le diff staged → `feat/user-auth-oauth2` plutôt que saisie manuelle

### 1.3.2 — AI conflict & merge insight

- **Explication de conflit en langage naturel** : le `DecisionTrace` existant est rendu lisible par un LLM ("ce hunk modifie la signature de `login()` des deux côtés — manuel obligatoire") et surfacé dans le merge editor desktop
- **Prévention de conflit avant rebase/merge** : la simulation `merge-tree` + `git show` actuelle est complétée par un résumé IA du risque ("3 fichiers touchent l'auth, haute probabilité de régression si non testés")
- Exposition desktop du tool MCP `gitwand_explain_hunk` déjà présent côté core

### 1.3.3 — AI commit workflow

- **Message de stash auto** : avant `git stash`, l'IA propose un message depuis le diff unstaged (`wip: refactor user service tests`)
- **Squash sémantique en rebase interactif** : l'IA regroupe les commits candidats au squash par intention ("ces 4 commits touchent le même test") et propose le message combiné
- **Classement IA pour Absorb** : plutôt que prendre le premier commit via `git blame`, ranking sémantique des commits candidats (message + diff) pour suggérer la meilleure cible

### 1.3.4 — AI history & search

- **Recherche de commits en langage naturel** dans le `CommitLog` : "quand a-t-on introduit la pagination du log ?" → requête sémantique sur l'historique
- **Blame contextuel** : bouton dans le `FileHistoryViewer` / blame → "explique pourquoi cette ligne a changé" avec contexte des commits voisins
- **Générateur de release notes / changelog** : depuis `git log <tag>..<tag>` → markdown structuré (Added / Changed / Fixed), pré-rempli dans les release notes GitHub

---

## Next — v1.4.0 — Visual diff & distribution

### 1.4.1 — Folder diff

- Comparer deux dossiers, branches ou commits — arbre récursif avec indicateurs ajouté/supprimé/modifié
- Filtrage par type de fichier, pattern glob, type de changement
- Résumé IA des changements de dossier (bonus : réutilise la plomberie v1.3)

### 1.4.2 — Image diff (différenciateur fort)

- Comparaison visuelle : side-by-side, overlay, blink, slider split
- Formats : PNG, JPEG, SVG, WebP, GIF
- Heatmap des zones modifiées, métadonnées (taille, dimensions, profil couleur)
- Description IA des changements visuels (alt text, zones d'attention)

### 1.4.3 — Submodules & Worktrees

- Initialiser, mettre à jour, naviguer dans les submodules depuis l'UI
- Git worktrees : créer, lister, supprimer — chaque worktree dans un onglet
- Checkout rapide via worktree sans switcher

### 1.4.4 — MCP Registry & npm publish

- Publier `@gitwand/mcp` sur npm
- Soumettre au MCP Registry officiel
- Publier `@gitwand/cli` sur npm

---

## Later — v2.0.0

### Intégrations forge

- GitLab MRs : API REST/GraphQL native (lister, reviewer, merger)
- Bitbucket PRs : Support Bitbucket Cloud
- Multi-compte GitHub/GitLab (personnel + pro)
- Draft PR convert depuis l'app

### Distribution & signing

- Signature macOS (notarization Apple)
- Signature Windows (Authenticode)
- Auto-update channel (stable / beta)
- Homebrew cask, winget, Flatpak

### Performance à grande échelle

- Partial clone / sparse checkout pour monorepos massifs
- Pagination lazy du log sur repos 100k+ commits
- Background indexing pour la recherche dans les commits

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

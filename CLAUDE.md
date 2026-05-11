@AGENTS.md

## GitWand — Vue d'ensemble

GitWand est un client Git desktop natif avec un moteur de résolution automatique de conflits Git et des features AI intégrées.

**Stack technique :** Tauri 2, Vue 3, Rust, TypeScript, pnpm monorepo

**Versions actuelles :**

| Package | Nom npm | Version |
|---|---|---|
| `apps/desktop` | `@gitwand/desktop` | 2.8.3 |
| `packages/core` | `@gitwand/core` | 2.8.3 |
| `packages/cli` | `@gitwand/cli` | 2.8.3 |
| `packages/mcp` | `@gitwand/mcp` | 2.8.3 |
| `packages/vscode` | `gitwand-vscode` | 1.2.0 |

## Architecture monorepo

```
GitWand/
├── apps/
│   └── desktop/          # App Tauri 2 + Vue 3
├── packages/
│   ├── core/             # Moteur TS résolution conflits
│   ├── cli/              # CLI Node.js @gitwand/cli
│   ├── mcp/              # Serveur MCP @gitwand/mcp
│   └── vscode/           # Extension VS Code
├── website/              # Docs VitePress
├── scripts/
│   └── bump-version.sh   # Script de versioning
├── .github/workflows/    # CI/CD
└── AGENTS.md             # Règles AI transverses
```

### Séparation des responsabilités

- **`packages/core`** — moteur portable (browser/Node/Tauri), logique de résolution PURE. Aucune dépendance Node.js native : doit rester compatible browser.
- **`apps/desktop`** — UI Vue 3 + backend Rust Tauri. Consomme `@gitwand/core` via workspace.
- **`packages/cli`** et **`packages/mcp`** — wrappers minces autour de `@gitwand/core`, pas de logique de résolution propre.
- **`packages/vscode`** — extension VS Code avec son propre lifecycle (activation events, contributes), utilise `@gitwand/core`.

**Règle critique :** ne jamais introduire de module Node.js dans `packages/core` (fs, path, child_process, etc.).

## Setup développement

```bash
# Prérequis : Node 20+, pnpm 9+, Rust stable
pnpm install

# Dev frontend uniquement (sans Rust/Tauri)
cd apps/desktop && pnpm dev:web

# Dev app complète (avec Rust/Tauri, recompile le backend)
cd apps/desktop && pnpm dev

# Build tous les workspaces
pnpm build

# Tests tous les workspaces
pnpm test
```

## Scripts importants

| Commande | Usage |
|---|---|
| `./scripts/bump-version.sh X.Y.Z` | Versioning coordonné monorepo — ne jamais éditer les versions à la main |
| `pnpm -r run build` | Build tous les workspaces |
| `pnpm -r run test` | Tests tous les workspaces |
| `cd apps/desktop && pnpm test:parity` | Tests de parité Rust ↔ JS |

## CI/CD

- `.github/workflows/ci.yml` — tests matrix Node 18/20/22
- `.github/workflows/release.yml` — release desktop (macOS universal, Ubuntu, Windows)
- `.github/workflows/publish.yml` — publication npm (`@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`)
- `.github/workflows/deploy-website.yml` — déploiement docs VitePress

## Documentation contextuelle

Chaque sous-répertoire possède son propre `CLAUDE.md` avec des règles spécifiques à son périmètre :

- `apps/desktop/CLAUDE.md` — App Tauri complète (scripts, config Tauri, binaires)
- `apps/desktop/src/CLAUDE.md` — Frontend Vue 3 (composants, stores, routing)
- `apps/desktop/src-tauri/CLAUDE.md` — Backend Rust (commandes Tauri, binaires, Cargo.toml)
- `packages/core/CLAUDE.md` — Moteur de résolution (contrainte browser, algorithmes)
- `packages/cli/CLAUDE.md` — CLI (commandes yargs, exit codes, stdin/stdout)
- `packages/mcp/CLAUDE.md` — Serveur MCP (outils MCP, protocole, transport stdio)
- `packages/vscode/CLAUDE.md` — Extension VS Code (activation, contributes, VSIX)

## Points d'attention globaux

- **Lire `AGENTS.md` en premier** (importé via `@AGENTS.md` en tête de ce fichier) — il contient les règles de sécurité et conventions critiques transverses.
- **Ne jamais éditer les versions manuellement** — utiliser `./scripts/bump-version.sh X.Y.Z`.
- **`packages/core` = zéro Node.js** — vérifier avant tout ajout de dépendance.
- Chaque sous-`CLAUDE.md` affine les règles pour son périmètre ; le lire avant de modifier le sous-répertoire correspondant.

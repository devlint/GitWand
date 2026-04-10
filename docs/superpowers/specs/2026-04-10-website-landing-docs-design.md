# GitWand Website — Landing Page + Documentation

## Context

GitWand is a mature project (332 tests, CI/CD builds for 3 platforms, desktop app, CLI, VS Code extension) but has no public-facing website. The README and markdown files in the repo are the only documentation. A landing page is needed to attract users and showcase the product, and a documentation site is needed to onboard them across all components (desktop, core, CLI, VS Code).

## Decisions

- **Stack**: VitePress (Vue-native, markdown-first, good defaults for doc + landing)
- **Location**: `website/` directory in the monorepo, added to `pnpm-workspace.yaml`
- **Hosting**: GitHub Pages at `laurent.github.io/GitWand`
- **Deploy**: GitHub Actions, triggered on push to `main` when `website/` changes

## Structure

```
website/
├── package.json
├── .vitepress/
│   └── config.ts
├── index.md                        # Landing page
├── guide/
│   ├── getting-started.md          # Installation (desktop, CLI, VS Code)
│   ├── desktop.md                  # Desktop app tour
│   ├── cli.md                      # CLI usage & workflows
│   ├── vscode.md                   # VS Code extension
│   └── conflict-resolution.md      # How the engine works (8 patterns, scoring, traces)
├── reference/
│   ├── core-api.md                 # @gitwand/core public API
│   ├── config.md                   # .gitwandrc format & policies
│   └── cli-commands.md             # CLI command reference
└── public/
    └── (logo, screenshots, OG images)
```

## Landing Page (`index.md`)

### Hero
- Title: "GitWand — Git's magic wand"
- Subtitle: emphasizes automatic conflict resolution + fast native Git client
- 2 CTAs: "Download" (GitHub Releases) + "Documentation"
- Screenshot of the desktop app

### Features (3-4 blocks)
1. **Native Git client** — Tauri 2 + Vue 3, lightweight, commit/push/pull/branches, DAG graph, diff viewer
2. **Smart conflict resolution** — 8 patterns, composite confidence scoring, automatic resolution of trivial conflicts
3. **Cross-platform** — Desktop (macOS, Linux, Windows) + CLI + VS Code extension
4. **Format-aware** — Specialized JSON/Markdown resolvers, configurable merge policies

### Download Section
- Per-platform buttons: macOS DMG, Linux AppImage/DEB, Windows MSI
- Link to GitHub Releases

### Footer
- Links: GitHub, Documentation, Contributing, MIT License

## Documentation

### Guide (tutorials, onboarding)
- **Getting Started**: install all components, first launch, basic workflow
- **Desktop**: full app tour — staging (line/hunk level), commit, branches, merge preview, diff viewer, blame, file history, DAG, repo switcher, settings
- **CLI**: `resolve` and `status` commands, CI integration, git hook usage
- **VS Code**: extension install, CodeLens annotations, diagnostics panel, inline resolution
- **Conflict Resolution**: how the engine works — 8 patterns (same_change, one_side_change, delete_no_change, non_overlapping, whitespace_only, value_only_change, generated_file, complex), 3-way diff, composite confidence scoring (typeClassification, dataRisk, scopeImpact), decision traces

### Reference (API, config)
- **Core API**: public API of `@gitwand/core` — `parse()`, `resolve()`, `diff()`, types, resolver options
- **Config**: `.gitwandrc` format, policies (prefer-ours, prefer-theirs, prefer-safety, prefer-merge, strict), confidence thresholds, format-specific settings
- **CLI Commands**: exhaustive reference of all commands and flags

### Navigation
- **Navbar**: Logo + "GitWand" | Guide | Reference | GitHub icon
- **Sidebar**: auto-generated from `guide/` and `reference/` directory structure

## VitePress Configuration (`.vitepress/config.ts`)

Key settings:
- `base: '/GitWand/'` for GitHub Pages subdirectory
- `title: 'GitWand'`
- `description: "Git's magic wand — smart conflict resolution & native Git client"`
- Theme config: navbar links, sidebar groups, social links (GitHub), footer
- Landing page uses VitePress built-in `layout: home` with `hero` and `features` frontmatter

## Deployment

### GitHub Actions (`.github/workflows/deploy-website.yml`)
- **Trigger**: `push` to `main`, filtered to `website/**` path changes
- **Steps**: checkout → setup Node 20 → pnpm install → `vitepress build` → deploy with `actions/deploy-pages@v4`
- Uses `actions/configure-pages` + `actions/upload-pages-artifact`

### Workspace Integration
- Add `'website'` to `pnpm-workspace.yaml` packages list
- `website/package.json` with `vitepress` as devDependency, scripts: `dev`, `build`, `preview`

### Local Development
- `cd website && pnpm dev` — hot-reload preview on localhost

## Out of Scope (for now)
- i18n (French/English) for the website
- Blog/changelog section
- Search (can be added later via VitePress built-in search)
- Custom theme beyond VitePress defaults
- Analytics

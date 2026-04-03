# GitWand Desktop — Phase 4

## Stack prévue
- **Tauri 2.x** — Shell natif léger (Rust)
- **Vue 3** + Composition API — Frontend
- **@gitwand/core** — Moteur de résolution (TypeScript)

## Pour initialiser (quand tu seras prêt)

```bash
# Prérequis : installer Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Créer le projet Tauri + Vue depuis ce dossier
pnpm create tauri-app . --template vue-ts
```

## Architecture prévue

```
apps/desktop/
├── src/              # Frontend Vue 3
│   ├── App.vue
│   ├── components/
│   │   ├── MergeEditor.vue      # Éditeur 3-way merge
│   │   ├── ConflictList.vue     # Liste des conflits
│   │   ├── ResolutionBadge.vue  # Badge type/confiance
│   │   └── DiffView.vue         # Vue diff inline
│   └── composables/
│       └── useGitWand.ts        # Wrapper réactif du core
├── src-tauri/        # Backend Rust (Tauri)
│   ├── src/
│   │   └── main.rs
│   └── Cargo.toml
├── index.html
└── package.json
```

@../../CLAUDE.md

# apps/desktop — Tauri 2 + Vue 3

Application desktop GitWand. Combine un frontend Vue 3 (Vite 6) et un backend Rust (Tauri 2). Supporte un mode "web only" pour développer sans Rust.

## Commandes de développement

**Mode web (sans Rust) :**
```bash
pnpm dev:web    # Lance dev-server.mjs + Vite sur localhost:1420, mock backend
pnpm dev:server # Lance uniquement le backend de dev (dev-server.mjs)
```

**Mode desktop complet (Rust requis) :**
```bash
pnpm dev        # Copy grammars + Vite dev server (Tauri window en dehors)
```

**Build :**
```bash
pnpm build          # Copy grammars + vue-tsc + vite build → dist/
pnpm tauri build    # Build app complète, embed frontend dans le binaire Rust
```

**Tests :**
```bash
pnpm test           # Vitest (jsdom), src/**/*.test.ts
pnpm test:parity    # Test parité Rust↔JS via parity-probe (vitest.config.parity.ts)
```

## Règle CRITIQUE — Binaires Tauri

`tauri-bundler` bundle automatiquement **tous** les `[[bin]]` dans l'installeur. Les binaires secondaires **doivent** être déclarés sous `[[example]]` dans `src-tauri/Cargo.toml`.

```toml
# Correct
[[example]]
name = "parity-probe"
required-features = ["parity"]

# Ne jamais faire ca
[[bin]]
name = "parity-probe"
```

## Parity Probe

`src-tauri/examples/parity-probe.rs` reproduit en Rust la logique de résolution de conflits de `packages/core`. Permet de vérifier que les deux implémentations donnent des résultats identiques.

```bash
pnpm test:parity
# Exécute vitest.config.parity.ts — lance le binaire Rust + le JS, compare les sorties
```

## Configuration Tauri

- `tauri.conf.json` — Fenêtre, plugins, updater endpoints, bundle icons
- Updater : `https://gitwand.app/update/latest.json` (primary) + GitHub releases (fallback)
- `capabilities/` — Permissions Tauri. Ne pas ajouter `shell:allow-execute` sans raison précise.

## Plugins Tauri actifs

| Plugin | Usage |
|---|---|
| `tauri-plugin-dialog` | File/folder pickers |
| `tauri-plugin-shell` | Exécution de commandes externes (gh, éditeurs) |
| `tauri-plugin-global-shortcut` | Raccourcis clavier globaux |
| `tauri-plugin-updater` | Auto-updates |
| `tauri-plugin-process` | Gestion des processus |

## Architecture IPC

Toutes les commandes Rust sont déclarées via `#[tauri::command]` dans `src-tauri/src/lib.rs` (~800 lignes). Leurs wrappers TypeScript typés sont dans `src/utils/backend.ts`.

Quand on ajoute une commande Rust, le wrapper TS correspondant doit être ajouté dans la **même PR**.

## Tests Vitest

- Config principale : `vite.config.ts` (environnement `jsdom`)
- Config parité : `vitest.config.parity.ts`
- Fichiers de test : `src/**/*.test.ts` et `src/**/__tests__/`
- Ne pas mocker les commandes Tauri dans les tests unitaires — utiliser `pnpm dev:web` avec le mock backend pour le dev interactif

## Performance invariants — règles à respecter (P6.4)

Liste tirée du chantier perf de mai 2026 (cf. `PERFORMANCE_PLAN.md` à la racine). Toute PR qui touche `apps/desktop/` doit s'y conformer ; un reviewer qui voit une violation a la légitimité de bloquer.

### Frontend Vue 3

**Polling**
- Aucun `setInterval` ne doit tourner inconditionnellement dès qu'un repo est ouvert. Toujours gater par une condition utile (`document.hidden`, état d'opération, opt-in utilisateur). Précédent : le poll `refreshRepoState` (3 s) qui spawnait un `git rev-parse` en idle a été identifié comme contributeur de la régression v2.6 → v2.8.
- Tout nouveau poll doit pauser sur `document.visibilitychange` quand `document.hidden`. Pattern à suivre : `_xxxPollEnabled` flag + `ensureXxxPoll()` reconciler. Voir `useGitRepo.ts` (P2.2).
- Préférer un seul interval consolidé (futur `useRepoPoller`) à plusieurs polls indépendants qui se marchent dessus.

**Watchers Vue**
- **Jamais** `{ deep: true }` sur `repoStatus`, `repoLog`, `repoFiles`, ou toute structure réactive contenant > 100 entrées. Le tracking deep est exponentiel.
- Préférer `watch(() => obj.specificField, …)` à `watch(obj, …, { deep: true })`.

**Imports & bundle**
- Tout panel/modal/vue conditionné par un `v-if` (sur un flag défaut faux) doit être lazy-loadé via `defineAsyncComponent(() => import(...))`. Voir `App.vue` (P1.2) pour le pattern.
- Les composants always-mounted (BaseModal, AppHeader, RepoSidebar, EditCommitOverlay, SplitCommitModal, AiSparkle) restent en eager — sont l'exception, pas la règle.
- Pour les libs lourdes avec coupage par feature (highlight.js par langage, etc.) : eager set minimal + lazy par dynamic import. Voir `utils/highlight.ts` (P4.3).
- Aucun `<img>` externe (badge GitHub, avatar, SVG distant) sans `loading="lazy"`, `decoding="async"`, `referrerpolicy="no-referrer"`. Sinon un host lent peut bloquer une image fetch slot pendant 15 s. Voir `DashboardView.vue` (P1.5).

**IPC payloads**
- Toute nouvelle commande Tauri qui peut retourner > 1 MB (logs, diffs, listes) doit avoir une pagination ou une troncature côté Rust. Voir `git_diff` truncation à 5 MB (P2.4) et `git_log` count par défaut 50.

### Backend Rust (`src-tauri/`)

**Process spawn**
- Toute fonction appelée sur un hot path (polling, workspace listing) doit éviter les `Command::new` répétés. Préférer libgit2 (crate `git2`) en lecture pour status/branch/ahead-behind. Voir `libgit2_*` helpers (P3.3a).
- Le user-facing `git_status` reste CLI-based pour préserver les parity tests (`tests/parity/`). Migration partielle uniquement.
- Tout résultat stable pour la durée de vie d'un repo ouvert (ex : `.git` dir résolu) doit être caché. Voir `GIT_DIR_CACHE` (P2.3).

**Parallélisation**
- Toute fonction `workspace_*_all` ou `*_all` qui itère sur N repos / N items DOIT utiliser `rayon::par_iter` ou `into_par_iter`, pas `iter` séquentiel. Le coût de fork de thread est négligeable comparé au gain N× sur des opérations I/O-bound. Voir P3.2.

**Profile.release**
- Ne jamais retirer `lto = "fat"`, `codegen-units = 1`, `strip = "symbols"` dans `Cargo.toml`. Validés en P3.1.
- Ne jamais ajouter `panic = "abort"` sans audit complet : Tauri command handlers reposent sur l'unwinding pour récupérer d'un panic.

### Build & CI

- Ajouter une dépendance Cargo nouvelle = mesurer son impact compile + binaire (`cargo build --release` time + `du -h target/release/...`).
- Ajouter une dépendance npm nouvelle qui pèse > 50 KB gzipped = bénéfice clair OU lazy import obligatoire.
- Avant de merger une PR qui touche le hot path : profiler avec DevTools (Cmd+Option+I, activé via `tauri = { features = ["devtools"] }`).

@../CLAUDE.md

# src-tauri — Backend Rust (Tauri)

Ce répertoire est le backend Rust de l'application Tauri. `src/lib.rs` (1 133 lignes, mesuré 2026-08-18) est le bootstrap : structs de données partagées, `git_binary()`, `safe_repo_path()` et le `generate_handler!` final. La logique applicative elle-même vit dans `src/commands/` : 252 `#[tauri::command]` répartis sur 16 des 18 fichiers du répertoire (22 102 lignes au total ; `mod.rs` et `curl_util.rs` n'en déclarent aucune) — voir le détail plus bas. `src/git/` (2 840 lignes) porte l'exécution git bas niveau, `src/types.rs` (1 062 lignes) les types partagés. `src/main.rs` est un entry point minimal.

---

## Trust Boundaries — Modèle de sécurité

`lib.rs` définit 4 frontières de confiance explicites :

| # | Frontière | Règle |
|---|-----------|-------|
| 1 | **Filesystem** | Tout chemin frontend passe par `safe_repo_path()` avant toute opération |
| 2 | **Exécution git** | Pas de shell string interpolation — UNIQUEMENT `.arg()` par argument |
| 3 | **Processus externes** | `gh`, `claude`, éditeurs — séparés des commandes git, permissions capabilities requises |
| 4 | **IPC** | Frontend seul, jamais exposé réseau |

---

## `safe_repo_path()` — Règle absolue

**Ne jamais bypasser ou contourner `safe_repo_path()`.**

Cette fonction valide que le chemin ne contient pas de `..` ni de composants permettant de sortir du répertoire de travail. Elle DOIT être appelée sur tout chemin fourni par le frontend avant toute opération filesystem.

```rust
// Correct
fn read_file(cwd: String, path: String) -> Result<String> {
    let safe = safe_repo_path(&cwd, &path)?;  // valide le chemin
    std::fs::read_to_string(safe)
}

// JAMAIS — path traversal possible
fn read_file(cwd: String, path: String) -> Result<String> {
    let full = PathBuf::from(&cwd).join(&path);  // DANGER
    std::fs::read_to_string(full)
}
```

---

## Exécution git — Règle anti-injection

**Jamais construire une commande git avec string interpolation ou `shell=true`.**

```rust
// Correct — chaque argument séparé
Command::new(git_binary())
    .arg("log")
    .arg("--oneline")
    .arg("-n")
    .arg("50")
    .current_dir(&cwd)
    .output()?;

// JAMAIS — injection possible
Command::new("sh")
    .arg("-c")
    .arg(format!("git log --oneline {}", user_input))  // INJECTION
    .output()?;
```

---

## Variables d'environnement et secrets

- Les API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) ne doivent **jamais** apparaître dans les arguments de commande.
- Avant de spawner un process externe, strip toutes les variables sensibles de l'héritage si elles ne sont pas nécessaires.
- Ne jamais logger les variables d'environnement complètes dans les messages d'erreur.

---

## Structure du backend

`lib.rs` est organisé dans cet ordre :

1. Imports et structs de données partagées (`GitStatus`, `ConflictFile`, `CommitInfo`, etc.)
2. `git_binary()` — résolution du chemin git configurable
3. `safe_repo_path()` — validation des chemins
4. `run()` (L~389) — `tauri::generate_handler![...]` qui enregistre les 252 commandes

Les commandes elles-mêmes vivent dans `src/commands/`, un fichier par domaine
(mesuré 2026-08-18, `#[tauri::command]` par fichier) :

| Fichier | Commandes |
|---|---|
| `ops.rs` | 85 |
| `gitlab.rs` | 32 |
| `gh.rs` | 27 |
| `azure.rs` | 24 |
| `bitbucket.rs` | 21 |
| `read.rs` | 16 |
| `ai.rs` | 12 |
| `workspace.rs` | 9 |
| `files.rs` | 7 |
| `terminal.rs`, `mcp_catalog.rs` | 4 chacun |
| `scratch.rs`, `credentials.rs`, `github_api.rs` | 3 chacun |
| `secrets.rs`, `network.rs` | 1 chacun |
| `mod.rs`, `curl_util.rs` | 0 (helpers uniquement) |

`src/git/` (2 840 lignes) porte l'exécution git bas niveau, sans aucune commande
Tauri directe (`git/repo_lock.rs` documente le pattern `#[tauri::command]` en
commentaire, mais n'en déclare aucune — le lock est utilisé par les commandes de
`commands/`). `src/types.rs` (1 062 lignes) porte les types partagés.

---

## Checklist — Ajouter une nouvelle commande Tauri

1. Implémenter la fonction avec `#[tauri::command]`
2. Appeler `safe_repo_path()` si elle prend un chemin en paramètre
3. L'enregistrer dans `.invoke_handler(tauri::generate_handler![...])` dans `run()`
4. Ajouter le wrapper TypeScript typé dans `apps/desktop/src/utils/backend.ts`
5. Si la commande spawne un process externe, vérifier les permissions dans `capabilities/`

---

## Plugins Tauri — Permissions

Les permissions sont déclarées dans `capabilities/`. Toujours restreindre aux binaires nécessaires — ne jamais utiliser `shell:allow-execute` de façon globale.

| Plugin | Permissions |
|--------|-------------|
| `tauri-plugin-shell` | Permission explicite par commande autorisée |
| `tauri-plugin-dialog` | `dialog:allow-open`, `dialog:allow-save` |
| `tauri-plugin-global-shortcut` | `global-shortcut:allow-register` |
| `tauri-plugin-updater` | `updater:allow-check`, `updater:allow-download-and-install` |

---

## `Cargo.toml` — Règle `[[example]]` vs `[[bin]]`

Tout binaire secondaire (comme `parity-probe`) DOIT être déclaré sous `[[example]]`, jamais `[[bin]]`.

```toml
# Correct
[[example]]
name = "parity-probe"
path = "examples/parity_probe.rs"

# BRISE LE BUILD — tauri-bundler inclut tous les [[bin]] dans l'installeur
[[bin]]
name = "parity-probe"
```

Raison : tauri-bundler inclut automatiquement tous les `[[bin]]` dans l'installeur final. Les `[[example]]` ne sont pas touchés et ne sont pas construits par défaut.

Build manuel : `cargo build --example parity-probe` → `target/debug/examples/parity-probe`

---

## Dépendances Rust notables

- `tauri 2.x` avec plugins séparés : `dialog`, `shell`, `global-shortcut`, `updater`, `process`
- `reqwest` + `tokio` sont tirés transitivement, pas en dépendance directe. Une
  seule version résolue (`reqwest 0.13`, rustls) : `tauri-plugin-updater` et
  notre fork `[patch.crates-io]` `devlint/tauri-plugin-aptabase` (branche
  `chore/reqwest-013-rustls`) partagent désormais le même
  `default-features = false` + `rustls-no-provider`, avec un provider crypto
  `ring` (pur Rust, sans compilation native) installé défensivement par les
  deux plugins. `libssl-dev`/`native-tls`/`openssl-sys` ont disparu du graphe
  (v3.6.6, P4.1).
- `tauri-plugin-aptabase` (télémétrie de lancement anonyme) est une dépendance
  **optionnelle**, gatée par la feature Cargo `telemetry` (défaut : absente) —
  `cargo check`/`cargo test`/`cargo build` en dev ne la compilent plus du tout.
  Tout build non-debug **doit** passer `--features telemetry` (voir
  `release.yml` / `ci.yml`'s `bundle-smoke`) : `lib.rs` a un `compile_error!`
  qui fait échouer la compilation d'un build non-debug qui l'omettrait, plutôt
  que de perdre silencieusement l'analytics (v3.6.6, P4.2).
- `serde` / `serde_json` pour la sérialisation des types vers le frontend
- `dirs 5` pour la résolution des chemins système
- `base64 0.22` pour l'encodage des contenus binaires

---

## Nettoyage disque `target/` — `cargo-sweep` (remédiation ponctuelle)

`target/` (11 GB mesurés, `debug` + `release`) grossit avec chaque worktree qui
lance `cargo` (`.claude/worktrees/…`, `git worktree add`) — un nouveau
`target/` de plusieurs GB apparaît par worktree, sans nettoyage automatique.

`cargo-sweep` (`cargo install cargo-sweep`) supprime les artefacts de build
inutilisés depuis N jours. Il s'invoque **depuis `apps/desktop/src-tauri`** (le
répertoire qui contient le `Cargo.toml`/`Cargo.lock` visé, pas la racine du
monorepo, qui n'a pas de `Cargo.toml`) :

```bash
cd apps/desktop/src-tauri
cargo sweep --time 14 --recursive
```

`--recursive` couvre aussi les `target/` de sous-répertoires (ex.
`target/rust-analyzer` créé par la config `.vscode/settings.json`, ou d'autres
worktrees si on pointe la commande sur leur propre `src-tauri`).

**Ceci est une commande à lancer ponctuellement, à la main, quand le disque est
sous pression — ce n'est pas un script npm ni un hook automatisé.** Ne pas
l'exécuter sur une machine où un autre build/agent est potentiellement en cours
(elle peut supprimer des artefacts qu'un build concurrent est en train
d'utiliser).

Repère utile : après l'étape `[profile.dev.package."*"] opt-level = 1`
(`Cargo.toml`), `target/debug` est invalidé d'un coup — c'est le moment idéal
pour lancer `cargo sweep` et récupérer l'espace de l'ancien `target/debug`.

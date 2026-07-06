@../CLAUDE.md

# src-tauri — Backend Rust (Tauri)

Ce répertoire est le backend Rust de l'application Tauri. Toute la logique applicative est dans `src/lib.rs` (~800 lignes). `src/main.rs` est un entry point minimal.

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

## Structure de `lib.rs`

Le fichier est organisé dans cet ordre :

1. Imports et structs de données (`GitStatus`, `ConflictFile`, `CommitInfo`, etc.)
2. `git_binary()` — résolution du chemin git configurable
3. `safe_repo_path()` — validation des chemins
4. Commandes `#[tauri::command]` groupées par domaine :
   - Status & diff : `git_status`, `git_diff`, `git_log`
   - Opérations fichiers : `read_file`, `write_file`, `list_dir`
   - Merge & conflits : `get_conflicted_files`, `git_merge`, `git_merge_tree`
   - Branches : `git_branch`, `git_checkout`, `git_push`, `git_pull`
   - History avancée : `git_show`, `git_blame`, `file_history`
   - Rebase : `git_rebase_interactive`, `git_rebase_continue`
   - Stash, tags, cherry-pick, worktree
   - Processus externes : `spawn_process`, `open_in_editor`
5. `run()` — registration de tous les handlers Tauri

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
- Une seule dépendance HTTP/async : `reqwest` + `tokio`, tirés transitivement par `tauri-plugin-aptabase` (télémétrie de lancement anonyme, release-only). Le reste du backend reste synchrone.
- `serde` / `serde_json` pour la sérialisation des types vers le frontend
- `dirs 5` pour la résolution des chemins système
- `base64 0.22` pour l'encodage des contenus binaires

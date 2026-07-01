# Audit — apps/desktop/src-tauri

**Date :** 2026-04-28
**Scope :** `apps/desktop/src-tauri/src/lib.rs`, `Cargo.toml`, `apps/desktop/src/utils/backend.ts`
**Checks :** 6 axes · ✅ 4 conformes · ⚠️ 1 avertissement · ❌ 1 violation

---

## ✅ Points conformes

### Axe 1 — safe_repo_path() sur les commandes fichier
Les 3 commandes qui effectuent des accès fichier directs (`read_file`, `write_file`, `read_file_at_revision`) appellent toutes `safe_repo_path()` avant d'utiliser le chemin utilisateur (lignes 692, 698, 753). Les commandes git passent `cwd` à `.current_dir()` et non à la fonction — ce qui est correct par construction : git confine lui-même ses accès au répertoire courant.

### Axe 2 — Aucune interpolation shell dans les commandes git
Aucune commande git n'est construite via `format!()` pour être passée en argument chaîne à `Command::new("git")`. Tous les arguments utilisateur sont passés via `.arg()` ou `.args()`, ce qui rend l'injection de commande mécaniquement impossible. Un usage de `format!("--author={}", author_filter)` (ligne 634) est présent dans `git_log`, mais la valeur est passée via `.args()` — safe par construction.

### Axe 5 — Aucun `[[bin]]` dans Cargo.toml
Cargo.toml ne contient aucune section `[[bin]]`. Le binaire auxiliaire `parity-probe` est déclaré en `[[example]]` (lignes 27–29), avec un commentaire explicatif rappelant le bug de release v1.5.1 causé par un `[[bin]]`. ✅ Conforme à la règle AGENTS.md.

### Axe 6 — Pas de fuite de secrets vers les CLIs externes
Une fonction helper `strip_claude_auth_env()` est définie (ligne 4002) : elle supprime explicitement les variables `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` et autres tokens avant tout spawn de claude/codex. Appelée aux lignes 4413 et 4486. L'approche est correcte et défensive pour les processus sensibles.

---

## ❌ Violation à corriger

### [V1] `git_worktree_remove` absent du `generate_handler!` — Axe 3

**Fichier :** `apps/desktop/src-tauri/src/lib.rs`

La commande `git_worktree_remove` est définie avec `#[tauri::command]` (ligne ~4160) mais est **absente** du tableau `generate_handler![...]` (lignes 4984–5069). En conséquence, la commande n'est pas enregistrée dans le backend Tauri et est inaccessible depuis le frontend.

**Impact :** La fonction `gitWorktreeRemove()` dans `backend.ts` (ligne ~2553) appelle `invoke("git_worktree_remove", ...)` — cet appel échouera silencieusement ou avec une erreur "command not found" à runtime.

**Correction :**
```rust
// Dans generate_handler![...], après git_worktree_prune :
git_worktree_prune,
git_worktree_remove,  // ← AJOUTER
```

---

## ⚠️ Avertissement (non bloquant)

### [A1] Aucun `.env_clear()` sur les processus git — Axe 6

**Fichier :** `apps/desktop/src-tauri/src/lib.rs` — toutes les invocations `Command::new("git")`

Aucune commande git n'appelle `.env_clear()` avant `.spawn()` / `.output()`. Les processus git héritent donc de l'intégralité de l'environnement parent (PATH, HOME, ANTHROPIC_API_KEY si présent, etc.).

**Contexte :** C'est le comportement standard pour git — il a besoin de `HOME`, `GIT_DIR`, `SSH_AUTH_SOCK`, etc. Un `.env_clear()` casser ait l'authentification SSH et GPG. L'approche actuelle est conforme aux pratiques habituelles.

**Seule amélioration possible :** Sur les commandes git passant des informations utilisateur sensibles (emails, tokens via `GIT_ASKPASS`), envisager un `.env_remove("ANTHROPIC_API_KEY")` par précaution. Pas bloquant.

---

## Résumé des actions

| ID | Priorité | Effort | Action |
|---|---|---|---|
| V1 | 🔴 Haute | Faible | Ajouter `git_worktree_remove` dans `generate_handler!` (1 ligne) |
| A1 | 🟢 Basse | Faible | Optionnel : `.env_remove()` des secrets sur les spawn git sensibles |

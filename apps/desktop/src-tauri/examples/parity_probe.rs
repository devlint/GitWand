//! GitWand parity probe — test-only binary (P2.3).
//!
//! Expose quelques commandes Tauri critiques comme un petit binaire CLI,
//! pour qu'un harness Node (`apps/desktop/tests/parity/`) puisse les
//! appeler et comparer leurs sorties à celles du `dev-server.mjs`.
//!
//! Protocole :
//!   parity-probe <command> [--json <stdin-json>]
//!
//!   - `<command>` : nom noyau-style de la commande (`git-status`, `git-log`,
//!     `git-branches`). Tirets, pas underscores — pour matcher les routes
//!     HTTP du dev-server.
//!   - Arguments spécifiques à chaque commande lus depuis STDIN en JSON.
//!     Exemple `git-log` : `{"cwd": "...", "count": 10, "all": false}`.
//!
//! Sortie : JSON sur STDOUT (corps de la valeur retournée, OU `{"error": "..."}`
//! en cas d'échec de la commande). Exit code 0 pour succès, 1 pour erreur de
//! commande, 2 pour erreur d'invocation (args manquants, JSON invalide).
//!
//! Déclaré comme `[[example]]` dans `Cargo.toml` (pas `[[bin]]`) : tauri-bundler
//! auto-découvre toutes les entrées `[[bin]]` et tente de les embarquer dans
//! le bundle — même celles protégées par `required-features`. Les examples
//! sont ignorés par tauri-bundler.
//!
//! Build :
//!   cargo build --example parity-probe
//!
//! Le harness Node attend un binaire pré-compilé à un chemin connu, typiquement
//! `target/debug/examples/parity-probe` (surchargeable via `PARITY_PROBE` env var).

// Les `_parity` sont des wrappers publics qui délèguent aux `#[tauri::command]`
// privés de lib.rs. On ne peut pas importer les commandes directement : la
// proc-macro de Tauri génère une aide `__cmd__<name>` qui entre en conflit si
// la fn elle-même est `pub`. Voir le bloc "Parity probe re-exports" dans lib.rs.
use gitwand_desktop_lib::{
    git_branches_parity, git_commit_submodule_changes_parity, git_log_parity,
    git_stash_list_parity, git_status_libgit2_parity, git_status_parity,
    git_submodule_branches_parity, scan_secrets_parity,
};
use serde_json::{json, Value};
use std::io::{self, Read};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: parity-probe <command>");
        eprintln!("commands: git-status, git-status-fast, git-log, git-branches, git-stash-list, git-submodule-branches, git-commit-submodule-changes, scan-secrets");
        return ExitCode::from(2);
    }

    let command = &args[1];

    // Corps JSON depuis stdin — vide autorisé si la commande n'attend rien
    // (mais toutes les commandes actuelles attendent au minimum un `cwd`).
    let mut raw = String::new();
    if io::stdin().read_to_string(&mut raw).is_err() {
        eprintln!("failed to read stdin");
        return ExitCode::from(2);
    }
    let input: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("invalid JSON on stdin: {}", e);
                return ExitCode::from(2);
            }
        }
    };

    // Helper : extrait un String obligatoire du JSON d'entrée.
    let must_str = |key: &str| -> Result<String, ExitCode> {
        match input.get(key).and_then(|v| v.as_str()) {
            Some(s) => Ok(s.to_string()),
            None => {
                eprintln!("missing required arg: {}", key);
                Err(ExitCode::from(2))
            }
        }
    };

    // Dispatch + sérialisation uniforme. Chaque branche convertit un
    // `Result<T, String>` en JSON pour stdout et détermine l'exit code.
    let (payload, exit) = match command.as_str() {
        "git-status" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_status_parity(cwd))
        }
        // Bench-only: libgit2 fast path in isolation. NOT used for parity
        // testing — the libgit2 output may diverge from CLI on edge cases.
        // The bench in `apps/desktop/perf/bench.mjs` runs both `git-status`
        // (CLI) and `git-status-fast` (libgit2) on the same fixture so the
        // delta is visible in the results table.
        "git-status-fast" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_status_libgit2_parity(cwd))
        }
        "git-log" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let count = input.get("count").and_then(|v| v.as_i64()).map(|v| v as i32);
            let all = input.get("all").and_then(|v| v.as_bool());
            let author = input.get("author").and_then(|v| v.as_str()).map(|s| s.to_string());
            to_json(git_log_parity(cwd, count, all, author))
        }
        "git-branches" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_branches_parity(cwd))
        }
        "git-stash-list" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_stash_list_parity(cwd))
        }
        "git-submodule-branches" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let path = match must_str("path") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_submodule_branches_parity(cwd, path))
        }
        "git-commit-submodule-changes" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_commit_submodule_changes_parity(cwd))
        }
        "scan-secrets" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let config = input.get("config").cloned().unwrap_or_else(|| json!({}));
            to_json(scan_secrets_parity(cwd, config))
        }
        other => {
            eprintln!("unknown command: {}", other);
            return ExitCode::from(2);
        }
    };

    println!("{}", payload);
    exit
}

/// Projection uniforme : succès → valeur sérialisée, erreur → `{"error": msg}`.
/// Les deux aboutissent à du JSON parseable ; l'exit code distingue.
fn to_json<T: serde::Serialize>(r: Result<T, String>) -> (String, ExitCode) {
    match r {
        Ok(v) => match serde_json::to_string(&v) {
            Ok(s) => (s, ExitCode::from(0)),
            Err(e) => (json!({"error": format!("serialize failure: {}", e)}).to_string(), ExitCode::from(1)),
        },
        Err(e) => (json!({"error": e}).to_string(), ExitCode::from(1)),
    }
}

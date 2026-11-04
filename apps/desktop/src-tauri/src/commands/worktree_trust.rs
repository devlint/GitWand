//! v3.13.0 — Trust for a repository's worktree hooks.
//!
//! A `.gitwandrc` arrives with `git clone`, so its `worktree.setup` /
//! `teardown` / `url` commands must never run without the user agreeing to
//! them. This module reads those commands from the **main** worktree's config
//! (never from a linked worktree's copy, which an agent could rewrite),
//! hashes them, and remembers which hash the user trusted for which repo in
//! `{data_local_dir}/gitwand/hook-trust.json`, outside any repository.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The three hook commands. Field order is the hash's canonical order: do not
/// reorder without changing the dev-server mirror (`dev-worktree-trust.mjs`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct WorktreeHooks {
    pub setup: Option<String>,
    pub teardown: Option<String>,
    pub url: Option<String>,
}

fn non_blank(v: Option<&serde_json::Value>) -> Option<String> {
    match v {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// Hooks from the text of a `.gitwandrc` (or the `gitwand` object of a
/// `package.json`). Same validity rule as `@gitwand/core`'s parser: a hook is
/// kept only if it is a non-blank string. Invalid JSON yields no hooks.
pub(crate) fn hooks_from_rc_text(text: &str) -> WorktreeHooks {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return WorktreeHooks::default();
    };
    WorktreeHooks {
        setup: non_blank(value.pointer("/worktree/setup")),
        teardown: non_blank(value.pointer("/worktree/teardown")),
        url: non_blank(value.pointer("/worktree/url")),
    }
}

/// Lowercase hex SHA-256 of the canonical JSON of the hooks, or `None` when
/// there is nothing to run (nothing to trust).
pub(crate) fn hooks_hash(h: &WorktreeHooks) -> Option<String> {
    use sha2::{Digest, Sha256};
    if h.setup.is_none() && h.teardown.is_none() && h.url.is_none() {
        return None;
    }
    let canonical = serde_json::to_string(h).ok()?;
    let digest = Sha256::digest(canonical.as_bytes());
    Some(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// Repo root → trusted hash. A missing or unreadable file is an empty store.
pub(crate) fn load_store(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Writes the store atomically (temp file, then rename).
pub(crate) fn save_store(path: &Path, store: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[allow(dead_code)] // used by the Tauri commands (Task 3)
fn store_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gitwand")
        .join("hook-trust.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gitwand-trust-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hooks_from_rc_reads_strings_and_drops_blanks() {
        let h =
            hooks_from_rc_text(r#"{"worktree":{"setup":"bin/up {name}","teardown":"  ","url":3}}"#);
        assert_eq!(
            h,
            WorktreeHooks {
                setup: Some("bin/up {name}".into()),
                teardown: None,
                url: None
            }
        );
        assert_eq!(hooks_from_rc_text("not json"), WorktreeHooks::default());
    }

    #[test]
    fn hooks_hash_none_without_hooks() {
        assert_eq!(hooks_hash(&WorktreeHooks::default()), None);
    }

    #[test]
    fn hooks_hash_test_vector() {
        // Shared with the dev-server test: canonical JSON is
        // {"setup":"a \"q\"\nb","teardown":null,"url":"é"}
        let h = WorktreeHooks {
            setup: Some("a \"q\"\nb".into()),
            teardown: None,
            url: Some("é".into()),
        };
        assert_eq!(
            hooks_hash(&h).unwrap(),
            "a9f492b9688f1a51668dd0d1224ace3f39822e1f61779ebd50051b34591d09f7"
        );
    }

    #[test]
    fn load_store_tolerates_corrupt_file() {
        let dir = scratch_dir("store");
        let p = dir.join("hook-trust.json");
        assert!(load_store(&p).is_empty());
        std::fs::write(&p, "{oops").unwrap();
        assert!(load_store(&p).is_empty());
        let mut s = HashMap::new();
        s.insert("/r".to_string(), "h".to_string());
        save_store(&p, &s).unwrap();
        assert_eq!(load_store(&p), s);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

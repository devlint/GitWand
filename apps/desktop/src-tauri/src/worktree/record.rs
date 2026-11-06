//! `$GIT_COMMON_DIR/gitwand/worktrees.json` (spec §3): the worktrees
//! GitWand created. Shared by every worktree of the repo, never committed.
//! This record is what "owned by GitWand" means.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Task,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeRecord {
    pub path: String,
    pub branch: String,
    pub base_ref: String,
    pub base_commit: String,
    pub created_at: u64,
    pub kind: Kind,
    /// The main checkout's branch when the worktree was created.
    pub source_branch: Option<String>,
}

/// Serializes read-modify-write of the file within this process.
static LOCK: Mutex<()> = Mutex::new(());

/// The repo's common git dir, absolute, from any of its checkouts.
pub(crate) fn common_dir(cwd: &Path) -> Result<PathBuf, String> {
    let out = crate::git::git_cmd()
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    ))
}

fn file(common: &Path) -> PathBuf {
    common.join("gitwand").join("worktrees.json")
}

/// The comparison key of a recorded path. On Windows, one folder has
/// several spellings (`\\?\C:\…` from canonicalize, `C:/…` from git, any
/// case): they must all find the same record.
pub(crate) fn record_key(raw: &str, windows: bool) -> String {
    if windows {
        crate::worktree::hooks::strip_verbatim(raw)
            .replace('/', "\\")
            .to_lowercase()
    } else {
        raw.to_string()
    }
}

fn canonical(path: &Path) -> String {
    let p = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    record_key(&p.to_string_lossy(), cfg!(windows))
}

fn read(common: &Path) -> Vec<WorktreeRecord> {
    std::fs::read_to_string(file(common))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(common: &Path, records: &[WorktreeRecord]) -> Result<(), String> {
    let path = file(common);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Every record; a missing or unreadable file is no record.
pub(crate) fn load(common: &Path) -> Vec<WorktreeRecord> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(common)
}

/// Adds the record, replacing one with the same (canonical) path.
pub(crate) fn upsert(common: &Path, mut rec: WorktreeRecord) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let given = Path::new(&rec.path);
    let resolved = given.canonicalize().unwrap_or_else(|_| given.to_path_buf());
    let key = canonical(&resolved);
    rec.path = crate::worktree::hooks::display_path(&resolved);
    let mut all = read(common);
    all.retain(|r| canonical(Path::new(&r.path)) != key);
    all.push(rec);
    write(common, &all)
}

pub(crate) fn remove(common: &Path, path: &Path) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = canonical(path);
    let mut all = read(common);
    let before = all.len();
    all.retain(|r| canonical(Path::new(&r.path)) != key);
    if all.len() == before {
        return Ok(());
    }
    write(common, &all)
}

pub(crate) fn find(common: &Path, path: &Path) -> Option<WorktreeRecord> {
    let key = canonical(path);
    load(common)
        .into_iter()
        .find(|r| canonical(Path::new(&r.path)) == key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;

    fn rec(path: &Path, branch: &str) -> WorktreeRecord {
        WorktreeRecord {
            path: path.to_string_lossy().to_string(),
            branch: branch.into(),
            base_ref: "origin/main".into(),
            base_commit: "abc".into(),
            created_at: 1,
            kind: Kind::Manual,
            source_branch: Some("main".into()),
        }
    }

    #[test]
    fn record_key_matches_windows_spellings_of_one_path() {
        // canonicalize() gives `\\?\C:\…`; `git worktree list` prints `C:/…`,
        // which is all a removal has once a teardown deleted the folder.
        let a = record_key(r"\\?\C:\Users\Me\repo.worktrees\fix", true);
        assert_eq!(a, record_key("C:/Users/me/repo.worktrees/fix", true));
        assert_eq!(record_key("/x/Repo", false), "/x/Repo");
    }

    #[test]
    fn record_upsert_find_remove_round_trip() {
        let repo = TempRepo::new();
        let common = common_dir(&repo.path).unwrap();
        assert_eq!(common, repo.path.join(".git"));
        let wt = repo.sandbox.join("wt");
        std::fs::create_dir_all(&wt).unwrap();

        assert!(find(&common, &wt).is_none());
        upsert(&common, rec(&wt, "a")).unwrap();
        upsert(&common, rec(&wt, "b")).unwrap();
        assert!(common.join("gitwand").join("worktrees.json").is_file());
        assert_eq!(load(&common).len(), 1);
        assert_eq!(find(&common, &wt).unwrap().branch, "b");

        remove(&common, &wt).unwrap();
        assert!(find(&common, &wt).is_none());
        assert!(load(&common).is_empty());
    }
}

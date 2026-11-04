//! The `worktree.dir` and `worktree.include` settings (spec §4), read from
//! the **main** worktree. Same validity rules as `parseWorktreeConfig` in
//! `packages/core/src/config.ts`: an invalid entry is dropped.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IncludeMode {
    Copy,
    Symlink,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IncludeEntry {
    pub path: String,
    pub mode: IncludeMode,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorktreeSettings {
    pub dir: Option<String>,
    pub include: Vec<IncludeEntry>,
}

fn non_blank(v: Option<&serde_json::Value>) -> Option<String> {
    match v {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn include_entry(v: &serde_json::Value) -> Option<IncludeEntry> {
    match v {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(IncludeEntry {
            path: s.clone(),
            mode: IncludeMode::Copy,
        }),
        serde_json::Value::Object(o) => {
            let path = non_blank(o.get("path"))?;
            let mode = match o.get("mode") {
                None => IncludeMode::Copy,
                Some(serde_json::Value::String(m)) if m == "copy" => IncludeMode::Copy,
                Some(serde_json::Value::String(m)) if m == "symlink" => IncludeMode::Symlink,
                Some(_) => return None,
            };
            Some(IncludeEntry { path, mode })
        }
        _ => None,
    }
}

/// `.worktreeinclude`: one path or pattern per line, `#` comments, blank
/// lines skipped, all copied.
fn parse_worktreeinclude(text: &str) -> Vec<IncludeEntry> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| IncludeEntry {
            path: l.to_string(),
            mode: IncludeMode::Copy,
        })
        .collect()
}

pub(crate) fn read_settings(main_root: &Path) -> WorktreeSettings {
    let text = crate::commands::ops::read_gitwandrc_text(main_root);
    let wt = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("worktree").cloned());
    let dir = non_blank(wt.as_ref().and_then(|w| w.get("dir")));
    let mut include: Vec<IncludeEntry> = wt
        .as_ref()
        .and_then(|w| w.get("include"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(include_entry).collect())
        .unwrap_or_default();
    if let Ok(file) = std::fs::read_to_string(main_root.join(".worktreeinclude")) {
        for e in parse_worktreeinclude(&file) {
            // The `.gitwandrc` entry wins: only it can say `symlink`.
            if !include.iter().any(|x| x.path == e.path) {
                include.push(e);
            }
        }
    }
    WorktreeSettings { dir, include }
}

/// Where new worktrees go: an absolute `dir` as is, a relative one under the
/// main worktree, otherwise the sibling `<main>.worktrees`.
pub(crate) fn worktrees_dir(main_root: &Path, s: &WorktreeSettings) -> PathBuf {
    match &s.dir {
        Some(d) if Path::new(d).is_absolute() => PathBuf::from(d),
        Some(d) => main_root.join(d),
        None => {
            let name = main_root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "repo".to_string());
            main_root
                .parent()
                .unwrap_or(main_root)
                .join(format!("{name}.worktrees"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;

    #[test]
    fn settings_reads_dir_and_include_and_worktreeinclude() {
        let repo = TempRepo::new();
        repo.write(
            ".gitwandrc",
            r#"{"worktree":{"dir":"wt","include":[".env",{"path":"a","mode":"symlink"},{"path":"b","mode":"bad"},3]}}"#,
        );
        repo.write(".worktreeinclude", "# c\n\n.env\nsecrets/\n");
        let s = read_settings(&repo.path);
        assert_eq!(s.dir.as_deref(), Some("wt"));
        assert_eq!(
            s.include,
            vec![
                IncludeEntry {
                    path: ".env".into(),
                    mode: IncludeMode::Copy
                },
                IncludeEntry {
                    path: "a".into(),
                    mode: IncludeMode::Symlink
                },
                IncludeEntry {
                    path: "secrets/".into(),
                    mode: IncludeMode::Copy
                },
            ]
        );
    }

    #[test]
    fn worktrees_dir_defaults_to_sibling() {
        let main = Path::new("/x/repo");
        assert_eq!(
            worktrees_dir(main, &WorktreeSettings::default()),
            PathBuf::from("/x/repo.worktrees")
        );
        let rel = WorktreeSettings {
            dir: Some("wt".into()),
            include: vec![],
        };
        assert_eq!(worktrees_dir(main, &rel), PathBuf::from("/x/repo/wt"));
        let abs = WorktreeSettings {
            dir: Some("/abs".into()),
            include: vec![],
        };
        assert_eq!(worktrees_dir(main, &abs), PathBuf::from("/abs"));
    }
}

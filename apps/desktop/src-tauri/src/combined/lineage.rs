//! `git_file_lineage` (v3.15): every commit of a file's `--follow` history
//! with the file's name there — all a file-history combined diff needs to
//! name the file's past paths, without the log bodies `git_file_log` carries.

use super::replay::{parse_log_names, toplevel, utf8_names, validate_paths};
use crate::git::git_cmd;
use crate::types::FileLineageEntry;
use std::process::Stdio;

/// Most commits a lineage may hold. Far beyond any real file history; past
/// it the request is refused rather than shipped over IPC.
pub(crate) const MAX_LINEAGE: usize = 200_000;

/// The `--follow` history of `path` (repository-root-relative, validated as
/// the combined diff's `paths` are), newest first. Run from the toplevel with
/// the combined diff's pinned config; read-only, no repo guard (as the
/// replay: it reads objects only).
pub(crate) fn file_lineage(cwd: &str, path: &str) -> Result<Vec<FileLineageEntry>, String> {
    file_lineage_capped(cwd, path, MAX_LINEAGE)
}

/// [`file_lineage`] with an explicit cap (tests only pass another one).
fn file_lineage_capped(cwd: &str, path: &str, max: usize) -> Result<Vec<FileLineageEntry>, String> {
    let top = toplevel(cwd)?;
    validate_paths(&top, &[path.to_string()])?;
    let limit = (max + 1).to_string();
    let out = git_cmd()
        .args([
            "-c",
            "diff.noprefix=false",
            "-c",
            "diff.mnemonicPrefix=false",
            "-c",
            "core.quotePath=false",
            "-c",
            "diff.renameLimit=7000",
            "-c",
            "diff.relative=false",
            "log",
            "--follow",
            "--no-show-signature",
            "--no-color",
            "--name-only",
            "-z",
            "-n",
            &limit,
            "--format=%x00%x01%H",
            "--",
            path,
        ])
        .env("GIT_LITERAL_PATHSPECS", "1")
        .current_dir(&top)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run git log: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git log failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let records = parse_log_names(utf8_names(&out.stdout)?)?;
    if records.len() > max {
        return Err(format!("File history too long: more than {max} commits."));
    }
    Ok(records
        .into_iter()
        .map(|(hash, names)| FileLineageEntry {
            hash,
            path: names.into_iter().next(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;

    fn cwd(r: &TempRepo) -> String {
        r.path.to_string_lossy().to_string()
    }

    fn commit(r: &TempRepo, msg: &str) -> String {
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", msg]);
        r.git(&["rev-parse", "HEAD"])
    }

    /// Every commit of the file, newest first, with its name there, across
    /// a rename; commits that do not touch it are not listed.
    #[test]
    fn follows_the_file_across_a_rename() {
        let r = TempRepo::new();
        r.write("dir/a.txt", "1\n");
        let c1 = commit(&r, "one\n\nbody that is not shipped");
        r.write("other", "o\n");
        commit(&r, "unrelated");
        r.git(&["mv", "dir/a.txt", "b.txt"]);
        let c2 = commit(&r, "rename");
        r.write("b.txt", "2\n");
        let c3 = commit(&r, "edit");
        let got = file_lineage(&cwd(&r), "b.txt").unwrap();
        let want: Vec<FileLineageEntry> = [(c3, "b.txt"), (c2, "b.txt"), (c1, "dir/a.txt")]
            .into_iter()
            .map(|(hash, p)| FileLineageEntry {
                hash,
                path: Some(p.to_string()),
            })
            .collect();
        assert_eq!(got, want);
    }

    /// Opened from a subdirectory: the path stays root-relative.
    #[test]
    fn reads_from_the_toplevel() {
        let r = TempRepo::new();
        r.write("sub/x", "1\n");
        let c = commit(&r, "x");
        let sub = r.path.join("sub").to_string_lossy().to_string();
        let got = file_lineage(&sub, "sub/x").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].hash, c);
        assert_eq!(got[0].path.as_deref(), Some("sub/x"));
    }

    /// The path is validated as the combined diff's `paths`.
    #[test]
    fn refuses_invalid_paths() {
        let r = TempRepo::new();
        r.write("f", "1\n");
        commit(&r, "f");
        let err = |p: &str| file_lineage(&cwd(&r), p).unwrap_err();
        assert_eq!(err("../x"), "path must not contain `..` (got: ../x)");
        assert_eq!(err(""), "path must not be empty");
        assert_eq!(
            err("./f"),
            "path must not have an empty or `.` component (got: ./f)"
        );
    }

    /// Past the cap the request is refused, not shipped truncated.
    #[test]
    fn a_history_past_the_cap_is_refused() {
        let r = TempRepo::new();
        for i in 0..3 {
            r.write("f", &format!("{i}\n"));
            commit(&r, "f");
        }
        assert_eq!(file_lineage_capped(&cwd(&r), "f", 3).unwrap().len(), 3);
        assert_eq!(
            file_lineage_capped(&cwd(&r), "f", 2).unwrap_err(),
            "File history too long: more than 2 commits."
        );
    }

    /// A literal pathspec: `*` is a name, not a glob.
    #[test]
    fn the_path_is_literal() {
        let r = TempRepo::new();
        r.write("a1", "1\n");
        commit(&r, "a1");
        assert!(file_lineage(&cwd(&r), "a*").unwrap().is_empty());
    }
}

//! Resolving user-supplied hashes and ordering them ancestors-first.

use crate::git::git_cmd;
use crate::types::CombinedCommit;
use std::collections::HashMap;

fn run(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    git_cmd()
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git: {e}"))
}

fn resolve(cwd: &str, h: &str) -> Result<String, String> {
    let spec = format!("{h}^{{commit}}");
    let out = run(cwd, &["rev-parse", "--verify", "--end-of-options", &spec])?;
    if !out.status.success() {
        return Err(format!("Unknown commit: {h}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Metadata of `hashes` keyed by full hash, with the committer timestamp.
fn describe(
    cwd: &str,
    hashes: &[String],
) -> Result<HashMap<String, (i64, CombinedCommit)>, String> {
    let mut args: Vec<&str> = vec![
        "log",
        "--no-walk=unsorted",
        "--no-show-signature",
        "--format=%H%x00%ct%x00%h%x00%s%x00%an%x00%aI",
        "--end-of-options",
    ];
    args.extend(hashes.iter().map(String::as_str));
    let out = run(cwd, &args)?;
    if !out.status.success() {
        return Err(format!(
            "git log failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut map = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() != 6 {
            continue;
        }
        let ts = f[1].parse::<i64>().unwrap_or(0);
        map.insert(
            f[0].to_string(),
            (
                ts,
                CombinedCommit {
                    hash: f[0].to_string(),
                    short_hash: f[2].to_string(),
                    subject: f[3].to_string(),
                    author: f[4].to_string(),
                    date: f[5].to_string(),
                },
            ),
        );
    }
    Ok(map)
}

/// Resolves each hash to a full commit id and returns them ancestors first.
/// Peels the "tips" (commits no other remaining one descends from) layer by
/// layer; each layer is sorted by committer date ascending.
pub(crate) fn resolve_and_order(
    cwd: &str,
    hashes: &[String],
) -> Result<Vec<CombinedCommit>, String> {
    let mut remaining: Vec<String> = Vec::new();
    for h in hashes {
        let full = resolve(cwd, h)?;
        if !remaining.contains(&full) {
            remaining.push(full);
        }
    }
    // `validate_hashes` dedups raw strings; a short prefix and the full hash
    // (or two cases of one hash) only collapse here.
    if remaining.len() < super::MIN_COMMITS {
        return Err("Select at least 2 commits.".to_string());
    }
    if remaining.len() > super::MAX_COMMITS {
        return Err("Select at most 50 commits.".to_string());
    }
    let meta = describe(cwd, &remaining)?;
    // A commit whose metadata line did not parse must not vanish silently.
    if let Some(missing) = remaining.iter().find(|h| !meta.contains_key(*h)) {
        return Err(format!("Could not read commit metadata: {missing}"));
    }
    let mut result: Vec<CombinedCommit> = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let tips: Vec<String> = if remaining.len() == 1 {
            remaining.clone()
        } else {
            let mut args: Vec<&str> = vec!["merge-base", "--independent"];
            args.extend(remaining.iter().map(String::as_str));
            let out = run(cwd, &args)?;
            if !out.status.success() {
                return Err(format!(
                    "git merge-base failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        };
        if tips.is_empty() {
            return Err("Could not order the selected commits.".to_string());
        }
        remaining.retain(|h| !tips.contains(h));
        let mut layer: Vec<&(i64, CombinedCommit)> =
            tips.iter().filter_map(|h| meta.get(h)).collect();
        layer.sort_by_key(|(ts, _)| *ts);
        let mut layer: Vec<CombinedCommit> = layer.into_iter().map(|(_, c)| c.clone()).collect();
        // Tips are newer than everything still remaining: prepend the layer.
        layer.extend(result);
        result = layer;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::TempRepo;
    use std::process::Command;

    fn cwd(r: &TempRepo) -> String {
        r.path.to_string_lossy().to_string()
    }

    fn pos(v: &[CombinedCommit], h: &str) -> usize {
        v.iter().position(|c| c.hash == h).unwrap()
    }

    /// Commit with explicit committer/author dates (unix seconds).
    fn commit_at(r: &TempRepo, rel: &str, msg: &str, ts: i64) -> String {
        r.write(rel, &format!("{msg}\n"));
        r.git(&["add", "-A"]);
        let date = format!("{ts} +0000");
        let out = Command::new(crate::git::git_binary())
            .args(["commit", "-q", "-m", msg])
            .env("GIT_COMMITTER_DATE", &date)
            .env("GIT_AUTHOR_DATE", &date)
            .current_dir(&r.path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        r.git(&["rev-parse", "HEAD"])
    }

    #[test]
    fn order_is_topological_not_click_order() {
        let r = TempRepo::new();
        let a = r.commit("a.txt", "a\n", "A");
        let _b = r.commit("b.txt", "b\n", "B");
        let c = r.commit("c.txt", "c\n", "C");
        let got = resolve_and_order(&cwd(&r), &[c.clone(), a.clone()]).unwrap();
        let hashes: Vec<&str> = got.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(hashes, vec![a.as_str(), c.as_str()]);
        assert_eq!(got[0].subject, "A");
        assert_eq!(got[0].short_hash, &a[..got[0].short_hash.len()]);
    }

    #[test]
    fn order_across_branches() {
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "b1"]);
        let x = commit_at(&r, "x.txt", "X", 2_000_000_000);
        let x2 = commit_at(&r, "x2.txt", "X2", 2_000_000_100);
        r.git(&["checkout", "-q", "main"]);
        r.git(&["checkout", "-q", "-b", "b2"]);
        let y = commit_at(&r, "y.txt", "Y", 1_900_000_000);
        let got = resolve_and_order(&cwd(&r), &[x2.clone(), y.clone(), x.clone()]).unwrap();
        assert_eq!(got.len(), 3);
        assert!(pos(&got, &x) < pos(&got, &x2));
        // Y is independent of X/X2: only ancestry is pinned.
        assert!(got.iter().any(|c| c.hash == y));
        // Within a layer, independent tips go by committer date: Y (older)
        // before X, whatever the input order.
        let got = resolve_and_order(&cwd(&r), &[x.clone(), y.clone()]).unwrap();
        let hashes: Vec<&str> = got.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(hashes, vec![y.as_str(), x.as_str()]);
    }

    #[test]
    fn duplicates_after_resolution_are_rebounded() {
        let r = TempRepo::new();
        let a = r.commit("a.txt", "a\n", "A");
        // Short prefix and upper-case full hash: distinct strings, one commit.
        let err = resolve_and_order(&cwd(&r), &[a[..8].to_string(), a.to_uppercase()]).unwrap_err();
        assert_eq!(err, "Select at least 2 commits.");
    }

    #[test]
    fn unknown_commit_errors() {
        let r = TempRepo::new();
        let a = r.commit("a.txt", "a\n", "A");
        let bogus = "deadbeefdeadbeef".to_string();
        let err = resolve_and_order(&cwd(&r), &[a, bogus.clone()]).unwrap_err();
        assert_eq!(err, format!("Unknown commit: {bogus}"));
    }
}

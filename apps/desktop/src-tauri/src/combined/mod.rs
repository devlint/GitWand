//! Combined diff of several selected commits (v3.15). This module holds the
//! input validation, the git version guard and the topological ordering; the
//! command itself builds on them.

pub(crate) mod budget;
pub(crate) mod order;
pub(crate) mod replay;

pub(crate) const MIN_COMMITS: usize = 2;
pub(crate) const MAX_COMMITS: usize = 50;

/// The replay needs `git merge-tree --write-tree`, added in git 2.38.
pub(crate) fn supports_combined_diff(v: Option<(u32, u32)>) -> bool {
    matches!(v, Some(v) if v >= (2, 38))
}

/// A hash typed by the user: 7 to 64 hex digits. Anything else (notably an
/// option-like string) is refused before it can reach a git argv.
fn is_valid_hash(h: &str) -> bool {
    (7..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validates the hashes, drops duplicates (first occurrence wins) and checks
/// the 2..=50 bounds on what remains.
pub(crate) fn validate_hashes(hashes: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::with_capacity(hashes.len());
    for h in hashes {
        if !is_valid_hash(h) {
            return Err(format!("Invalid commit hash: {h}"));
        }
        if !out.contains(h) {
            out.push(h.clone());
        }
    }
    if out.len() < MIN_COMMITS {
        return Err("Select at least 2 commits.".to_string());
    }
    if out.len() > MAX_COMMITS {
        return Err("Select at most 50 commits.".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_option_like_input() {
        let r = validate_hashes(&["--output=x".to_string(), "abcdef1".to_string()]);
        assert_eq!(r, Err("Invalid commit hash: --output=x".to_string()));
    }

    #[test]
    fn validate_dedups_and_bounds() {
        let a = "abcdef1".to_string();
        assert_eq!(
            validate_hashes(&[a.clone(), a.clone()]),
            Err("Select at least 2 commits.".to_string())
        );
        let many: Vec<String> = (0..51).map(|i| format!("abcdef{i:04}")).collect();
        assert_eq!(
            validate_hashes(&many),
            Err("Select at most 50 commits.".to_string())
        );
        let ok = validate_hashes(&[a.clone(), "abcdef2".into(), a.clone()]).unwrap();
        assert_eq!(ok, vec![a, "abcdef2".to_string()]);
    }

    #[test]
    fn version_floor() {
        assert!(!supports_combined_diff(Some((2, 37))));
        assert!(supports_combined_diff(Some((2, 38))));
        assert!(supports_combined_diff(Some((3, 0))));
        assert!(!supports_combined_diff(None));
    }
}

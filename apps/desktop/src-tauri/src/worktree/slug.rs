//! The worktree name used for `{name}` (spec §4): `[a-z0-9][a-z0-9-]{0,62}`.

const MAX_LEN: usize = 63;

/// Lowercase ASCII letters and digits; every run of anything else becomes
/// one `-`; leading and trailing dashes are dropped; at most 63 characters.
/// `None` when nothing usable remains.
pub(crate) fn slugify(name: &str) -> Option<String> {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.chars().take(MAX_LEN).collect();
    let slug = slug.trim_end_matches('-');
    (!slug.is_empty()).then(|| slug.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_the_spec_charset() {
        assert_eq!(slugify("Fix Login!").as_deref(), Some("fix-login"));
        assert_eq!(slugify("--a--b--").as_deref(), Some("a-b"));
        assert_eq!(slugify("ÉtÉ").as_deref(), Some("t"));
        assert_eq!(slugify("!!!"), None);
        assert_eq!(slugify(""), None);
        let long = slugify(&"a".repeat(80)).unwrap();
        assert_eq!(long.len(), 63);
        // A cut that lands on a dash never leaves it trailing.
        let cut = slugify(&format!("{}-b", "a".repeat(62))).unwrap();
        assert_eq!(cut, "a".repeat(62));
        for s in ["Fix Login!", "--a--b--", "x".repeat(70).as_str()] {
            let v = slugify(s).unwrap();
            assert!(v.chars().next().unwrap().is_ascii_alphanumeric());
            assert!(v
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        }
    }
}

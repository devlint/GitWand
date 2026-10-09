//! Shared input handling for the per-forge "edit PR" commands
//! (`gh_pr_edit`, `gl_mr_edit`, `az_pr_edit`, `bb_pr_edit`, `gitea_pr_edit`).
//!
//! Each forge names the description field differently (`body` on GitHub and
//! Gitea, `description` elsewhere), so the payload is built from the caller's
//! key names. A field left `None` is omitted: the forge keeps its value.

/// Validate an edit and return its fields as `(key, value)` pairs, title first.
///
/// Rejects an edit that changes nothing and a blank title — every forge
/// refuses an empty title, and failing here gives one consistent message.
pub(crate) fn edit_fields<'a>(
    title: &'a Option<String>,
    body: &'a Option<String>,
    body_key: &'static str,
) -> Result<Vec<(&'static str, &'a str)>, String> {
    let mut fields = Vec::new();
    if let Some(t) = title {
        if t.trim().is_empty() {
            return Err("The PR title cannot be empty.".to_string());
        }
        fields.push(("title", t.as_str()));
    }
    if let Some(b) = body {
        fields.push((body_key, b.as_str()));
    }
    if fields.is_empty() {
        return Err("Nothing to update: no title or description given.".to_string());
    }
    Ok(fields)
}

/// The same fields as a JSON object, for the REST-based forges.
pub(crate) fn edit_payload(
    title: &Option<String>,
    body: &Option<String>,
    body_key: &'static str,
) -> Result<serde_json::Value, String> {
    let mut map = serde_json::Map::new();
    for (k, v) in edit_fields(title, body, body_key)? {
        map.insert(k.to_string(), serde_json::Value::String(v.to_string()));
    }
    Ok(serde_json::Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_given_fields() {
        let p = edit_payload(&None, &Some("new body".into()), "description").unwrap();
        assert_eq!(p, serde_json::json!({ "description": "new body" }));
        let p = edit_payload(&Some("T".into()), &None, "body").unwrap();
        assert_eq!(p, serde_json::json!({ "title": "T" }));
    }

    #[test]
    fn allows_an_empty_body() {
        let p = edit_payload(&None, &Some(String::new()), "body").unwrap();
        assert_eq!(p, serde_json::json!({ "body": "" }));
    }

    #[test]
    fn rejects_blank_title_and_empty_edit() {
        assert!(edit_fields(&Some("  ".into()), &None, "body").is_err());
        assert!(edit_fields(&None, &None, "body").is_err());
    }
}

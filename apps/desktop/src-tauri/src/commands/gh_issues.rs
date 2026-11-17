//! Creating GitHub issues from inside GitWand (#301).
//!
//! An issue goes to `origin`'s GitHub repository or, on a fork, to its parent
//! (from the API's `parent`, never from an `upstream` remote: #298). Every
//! command that takes a `repo` checks it against those targets, recomputed
//! here, so the frontend cannot aim a write anywhere else.

use super::gh::{gh_api_on, gh_origin_repo, GhRepo};
use super::github_api::{rest_api_json, with_rest};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A repository an issue can be filed on.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueTarget {
    /// `owner/repo`.
    pub(crate) repo: String,
    pub(crate) html_url: String,
    pub(crate) has_issues: bool,
    pub(crate) is_origin: bool,
}

/// Where an issue can go from a repository, and where it goes by default:
/// the first target with issues turned on, `None` when none has.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueTargets {
    pub(crate) targets: Vec<IssueTarget>,
    pub(crate) default_repo: Option<String>,
}

fn target_from(v: &serde_json::Value, is_origin: bool) -> Option<IssueTarget> {
    let repo = v.get("full_name")?.as_str()?.to_string();
    Some(IssueTarget {
        html_url: v
            .get("html_url")
            .and_then(|u| u.as_str())
            .unwrap_or_default()
            .to_string(),
        has_issues: v
            .get("has_issues")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        repo,
        is_origin,
    })
}

/// The targets from `origin`'s repository JSON and, when it is a fork, its
/// parent's (`GET /repos/{o}/{r}` carries the parent as a full repository).
fn targets_from(origin: &serde_json::Value, parent: Option<&serde_json::Value>) -> IssueTargets {
    let mut targets: Vec<IssueTarget> = target_from(origin, true).into_iter().collect();
    let is_fork = origin
        .get("fork")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    if is_fork {
        if let Some(t) = parent.and_then(|p| target_from(p, false)) {
            targets.push(t);
        }
    }
    let default_repo = targets
        .iter()
        .find(|t| t.has_issues)
        .map(|t| t.repo.clone());
    IssueTargets {
        targets,
        default_repo,
    }
}

/// `GET {path}` on `repo`'s host: REST with the Settings token, else `gh api`.
pub(crate) fn api_get(cwd: &str, repo: &GhRepo, path: &str) -> Result<serde_json::Value, String> {
    if let Some(r) = with_rest(cwd, |tok| rest_api_json("GET", path, tok, None)) {
        return r;
    }
    gh_api_on(cwd, repo, "GET", path, None)
}

const TARGETS_TTL: Duration = Duration::from_secs(5 * 60);

/// The issue targets of `cwd`, cached per repository for five minutes (every
/// form action re-validates against them). Empty when `origin` is not GitHub.
pub(crate) fn issue_targets_inner(cwd: &str) -> Result<IssueTargets, String> {
    type Cache = HashMap<String, (IssueTargets, Instant)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((t, at)) = cache.lock().ok().and_then(|m| m.get(cwd).cloned()) {
        if at.elapsed() < TARGETS_TTL {
            return Ok(t);
        }
    }
    let Some(origin) = gh_origin_repo(cwd) else {
        return Ok(IssueTargets::default());
    };
    let o = api_get(cwd, &origin, &format!("repos/{}", origin.nwo))?;
    let t = targets_from(&o, o.get("parent"));
    if let Ok(mut m) = cache.lock() {
        m.insert(cwd.to_string(), (t.clone(), Instant::now()));
    }
    Ok(t)
}

/// `Ok` when `repo` is one of `targets` — with issues turned on when
/// `need_issues` (creating, reading labels and milestones).
fn check_target(targets: &IssueTargets, repo: &str, need_issues: bool) -> Result<(), String> {
    match targets.targets.iter().find(|t| t.repo == repo) {
        None => Err(format!("Not an issue target for this repository: {}", repo)),
        Some(t) if need_issues && !t.has_issues => Err(format!("Issues are disabled on {}", repo)),
        Some(_) => Ok(()),
    }
}

/// `repo` as a [`GhRepo`] on `origin`'s host, once checked against the
/// targets of `cwd`.
pub(crate) fn resolve_issue_target(
    cwd: &str,
    repo: &str,
    need_issues: bool,
) -> Result<GhRepo, String> {
    let targets = issue_targets_inner(cwd)?;
    check_target(&targets, repo, need_issues)?;
    let origin = gh_origin_repo(cwd).ok_or("No GitHub 'origin' remote in this repository.")?;
    Ok(origin.sibling(repo.to_string()))
}

/// Where an issue can be filed from `cwd` (#301).
#[tauri::command]
pub(crate) async fn gh_issue_targets(cwd: String) -> Result<IssueTargets, String> {
    tauri::async_runtime::spawn_blocking(move || issue_targets_inner(&cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn origin(has_issues: bool, fork: bool) -> serde_json::Value {
        json!({"full_name":"me/app","html_url":"https://github.com/me/app","has_issues":has_issues,"fork":fork})
    }
    fn parent(has_issues: bool) -> serde_json::Value {
        json!({"full_name":"org/app","html_url":"https://github.com/org/app","has_issues":has_issues})
    }
    fn repos(t: &IssueTargets) -> Vec<&str> {
        t.targets.iter().map(|x| x.repo.as_str()).collect()
    }

    #[test]
    fn not_a_fork_has_one_target() {
        let t = targets_from(&origin(true, false), None);
        assert_eq!(repos(&t), ["me/app"]);
        assert!(t.targets[0].is_origin);
        assert_eq!(t.targets[0].html_url, "https://github.com/me/app");
        assert_eq!(t.default_repo.as_deref(), Some("me/app"));
    }

    #[test]
    fn fork_with_issues_off_defaults_to_parent() {
        let t = targets_from(&origin(false, true), Some(&parent(true)));
        assert_eq!(repos(&t), ["me/app", "org/app"]);
        assert!(!t.targets[1].is_origin);
        assert_eq!(t.default_repo.as_deref(), Some("org/app"));
    }

    #[test]
    fn fork_with_issues_on_defaults_to_origin() {
        let t = targets_from(&origin(true, true), Some(&parent(true)));
        assert_eq!(repos(&t), ["me/app", "org/app"]);
        assert_eq!(t.default_repo.as_deref(), Some("me/app"));
    }

    #[test]
    fn no_target_with_issues_has_no_default() {
        let t = targets_from(&origin(false, true), Some(&parent(false)));
        assert_eq!(t.targets.len(), 2);
        assert_eq!(t.default_repo, None);
    }

    #[test]
    fn unknown_repo_is_not_a_target() {
        let t = targets_from(&origin(true, true), Some(&parent(false)));
        assert_eq!(
            check_target(&t, "evil/repo", false).unwrap_err(),
            "Not an issue target for this repository: evil/repo"
        );
    }

    #[test]
    fn target_without_issues_refused_only_when_issues_are_needed() {
        let t = targets_from(&origin(true, true), Some(&parent(false)));
        assert_eq!(
            check_target(&t, "org/app", true).unwrap_err(),
            "Issues are disabled on org/app"
        );
        assert!(check_target(&t, "org/app", false).is_ok());
        assert!(check_target(&t, "me/app", true).is_ok());
    }

    #[test]
    fn parent_ignored_when_origin_is_not_a_fork() {
        let t = targets_from(&origin(true, false), Some(&parent(true)));
        assert_eq!(repos(&t), ["me/app"]);
    }
}

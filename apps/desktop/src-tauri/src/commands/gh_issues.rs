//! Creating GitHub issues from inside GitWand (#301).
//!
//! An issue goes to `origin`'s GitHub repository or, on a fork, to its parent
//! (from the API's `parent`, never from an `upstream` remote: #298). Every
//! command that takes a `repo` checks it against those targets, recomputed
//! here, so the frontend cannot aim a write anywhere else.

use super::gh::{gh_api_on, gh_origin_repo, GhRepo};
use super::github_api::{rest_api_json, with_rest, with_rest_other_repo};
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
    /// The signed-in user may set labels, assignees and a milestone (triage
    /// rights or more). GitHub silently drops them otherwise, so the form
    /// does not offer them.
    pub(crate) can_triage: bool,
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
        can_triage: ["triage", "push", "maintain", "admin"].iter().any(|k| {
            v.pointer(&format!("/permissions/{}", k))
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
        }),
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

/// `method {path}` on `repo`'s host: REST with the Settings token, else `gh
/// api` (`body` sent on stdin). A refusal by the parent's organization does
/// not mark the checkout restricted (see [`with_rest_other_repo`]).
fn api_call(
    cwd: &str,
    repo: &GhRepo,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let rest = |tok: &str| rest_api_json(method, path, tok, body.as_deref());
    let is_origin = gh_origin_repo(cwd).as_ref() == Some(repo);
    let attempt = if is_origin {
        with_rest(cwd, rest)
    } else {
        with_rest_other_repo(cwd, rest)
    };
    match attempt {
        Some(r) => r,
        None => gh_api_on(cwd, repo, method, path, body),
    }
}

/// `GET {path}` on `repo`'s host.
pub(crate) fn api_get(cwd: &str, repo: &GhRepo, path: &str) -> Result<serde_json::Value, String> {
    api_call(cwd, repo, "GET", path, None)
}

const TARGETS_TTL: Duration = Duration::from_secs(5 * 60);

/// The issue targets of `cwd`, cached per repository for five minutes (every
/// form action re-validates against them); `fresh` reads them again, as the
/// form does when it opens (issues just turned on, `origin` just changed).
/// Empty when `origin` is not GitHub.
pub(crate) fn issue_targets_inner(cwd: &str, fresh: bool) -> Result<IssueTargets, String> {
    type Cache = HashMap<String, (IssueTargets, Instant)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if !fresh {
        if let Some((t, at)) = cache.lock().ok().and_then(|m| m.get(cwd).cloned()) {
            if at.elapsed() < TARGETS_TTL {
                return Ok(t);
            }
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
    let targets = issue_targets_inner(cwd, false)?;
    check_target(&targets, repo, need_issues)?;
    let origin = gh_origin_repo(cwd).ok_or("No GitHub 'origin' remote in this repository.")?;
    Ok(origin.sibling(repo.to_string()))
}

/// Where an issue can be filed from `cwd` (#301). `fresh` (default) re-reads
/// GitHub; `false` accepts the five-minute cache.
#[tauri::command]
pub(crate) async fn gh_issue_targets(
    cwd: String,
    fresh: Option<bool>,
) -> Result<IssueTargets, String> {
    // Fresh when the form opens; the availability check (every repository
    // switch) takes the cached answer.
    let fresh = fresh.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || issue_targets_inner(&cwd, fresh))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Create ─────────────────────────────────────────────────────────────────

/// The new issue's fields, as the form sends them.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateIssueInput {
    /// `owner/repo`, one of [`issue_targets_inner`]'s targets.
    pub(crate) repo: String,
    pub(crate) title: String,
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) labels: Vec<String>,
    #[serde(default)]
    pub(crate) assignees: Vec<String>,
    /// The milestone's number (what `POST /issues` takes, not its title).
    #[serde(default)]
    pub(crate) milestone: Option<i64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct CreatedIssue {
    pub(crate) number: i64,
    pub(crate) url: String,
}

/// The `POST /repos/{o}/{r}/issues` body: the title trimmed (refused when
/// empty), the body verbatim, empty lists and no milestone left out.
fn issue_payload(input: &CreateIssueInput) -> Result<serde_json::Value, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Title is required".to_string());
    }
    let mut p = serde_json::json!({ "title": title, "body": input.body });
    if !input.labels.is_empty() {
        p["labels"] = serde_json::json!(input.labels);
    }
    if !input.assignees.is_empty() {
        p["assignees"] = serde_json::json!(input.assignees);
    }
    if let Some(m) = input.milestone {
        p["milestone"] = serde_json::json!(m);
    }
    Ok(p)
}

fn created_from(v: &serde_json::Value) -> Result<CreatedIssue, String> {
    let number = v
        .get("number")
        .and_then(|n| n.as_i64())
        .ok_or("GitHub did not return the new issue's number")?;
    let url = v
        .get("html_url")
        .and_then(|u| u.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(CreatedIssue { number, url })
}

fn create_issue_inner(cwd: &str, input: &CreateIssueInput) -> Result<CreatedIssue, String> {
    // Checked before any call: a blank title costs no request.
    let payload = issue_payload(input)?.to_string();
    let repo = resolve_issue_target(cwd, &input.repo, true)?;
    let path = format!("repos/{}/issues", repo.nwo);
    created_from(&api_call(cwd, &repo, "POST", &path, Some(payload))?)
}

/// File an issue on one of `cwd`'s issue targets (#301).
#[tauri::command]
pub(crate) async fn gh_create_issue(
    cwd: String,
    input: CreateIssueInput,
) -> Result<CreatedIssue, String> {
    tauri::async_runtime::spawn_blocking(move || create_issue_inner(&cwd, &input))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Pickers: labels, milestones, assignees ────────────────────────────────

/// Up to `max_pages` pages of 100 of the array at `path` (no query string).
fn api_get_pages(
    cwd: &str,
    repo: &GhRepo,
    path: &str,
    query: &str,
    max_pages: u32,
) -> Result<Vec<serde_json::Value>, String> {
    let mut all = Vec::new();
    for page in 1..=max_pages {
        let v = api_get(
            cwd,
            repo,
            &format!("{}?{}per_page=100&page={}", path, query, page),
        )?;
        let arr = v.as_array().cloned().unwrap_or_default();
        let n = arr.len();
        all.extend(arr);
        if n < 100 {
            break;
        }
    }
    Ok(all)
}

fn opt_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|x| !x.is_empty())
        .map(String::from)
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct RepoLabel {
    pub(crate) name: String,
    pub(crate) color: String,
    pub(crate) description: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoMilestone {
    pub(crate) number: i64,
    pub(crate) title: String,
    pub(crate) due_on: Option<String>,
}

fn labels_from(items: &[serde_json::Value]) -> Vec<RepoLabel> {
    items
        .iter()
        .filter_map(|l| {
            Some(RepoLabel {
                name: opt_str(l, "name")?,
                color: opt_str(l, "color").unwrap_or_default(),
                description: opt_str(l, "description"),
            })
        })
        .collect()
}

fn milestones_from(items: &[serde_json::Value]) -> Vec<RepoMilestone> {
    items
        .iter()
        .filter_map(|m| {
            Some(RepoMilestone {
                number: m.get("number")?.as_i64()?,
                title: opt_str(m, "title")?,
                due_on: opt_str(m, "due_on"),
            })
        })
        .collect()
}

/// Users from GitHub's `/assignees` pages: deduplicated, sorted by login
/// (case-insensitive). Shared with the pull request reviewer candidates.
pub(crate) fn assignees_from(items: &[serde_json::Value]) -> Vec<crate::types::ReviewerCandidate> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<_> = items
        .iter()
        .filter_map(|u| {
            let login = opt_str(u, "login")?;
            seen.insert(login.clone())
                .then(|| crate::types::ReviewerCandidate {
                    login,
                    name: opt_str(u, "name"),
                    avatar_url: opt_str(u, "avatar_url"),
                })
        })
        .collect();
    out.sort_by_key(|a| a.login.to_lowercase());
    out
}

/// Labels of an issue target (up to 300).
#[tauri::command]
pub(crate) async fn gh_list_labels(cwd: String, repo: String) -> Result<Vec<RepoLabel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = resolve_issue_target(&cwd, &repo, true)?;
        let items = api_get_pages(&cwd, &r, &format!("repos/{}/labels", r.nwo), "", 3)?;
        Ok(labels_from(&items))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open milestones of an issue target (up to 100).
#[tauri::command]
pub(crate) async fn gh_list_milestones(
    cwd: String,
    repo: String,
) -> Result<Vec<RepoMilestone>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = resolve_issue_target(&cwd, &repo, true)?;
        let items = api_get_pages(
            &cwd,
            &r,
            &format!("repos/{}/milestones", r.nwo),
            "state=open&",
            1,
        )?;
        Ok(milestones_from(&items))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Users an issue on a target can be assigned to (up to 300).
#[tauri::command]
pub(crate) async fn gh_list_assignees(
    cwd: String,
    repo: String,
) -> Result<Vec<crate::types::ReviewerCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = resolve_issue_target(&cwd, &repo, true)?;
        let items = api_get_pages(&cwd, &r, &format!("repos/{}/assignees", r.nwo), "", 3)?;
        Ok(assignees_from(&items))
    })
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

    fn input(
        title: &str,
        body: &str,
        labels: Vec<&str>,
        assignees: Vec<&str>,
        milestone: Option<i64>,
    ) -> CreateIssueInput {
        CreateIssueInput {
            repo: "me/app".into(),
            title: title.into(),
            body: body.into(),
            labels: labels.into_iter().map(String::from).collect(),
            assignees: assignees.into_iter().map(String::from).collect(),
            milestone,
        }
    }

    #[test]
    fn payload_omits_empty_optionals() {
        let p = issue_payload(&input("  Bug  ", "", vec![], vec![], None)).unwrap();
        assert_eq!(p, json!({"title": "Bug", "body": ""}));
    }

    #[test]
    fn payload_keeps_body_verbatim() {
        let body = "a \"q\" \\ $HOME\n--flag\n".repeat(2000);
        let p = issue_payload(&input("t", &body, vec![], vec![], None)).unwrap();
        assert_eq!(p["body"].as_str().unwrap(), body);
    }

    #[test]
    fn payload_carries_labels_assignees_milestone() {
        let p = issue_payload(&input("t", "b", vec!["bug"], vec!["me"], Some(3))).unwrap();
        assert_eq!(p["labels"], json!(["bug"]));
        assert_eq!(p["assignees"], json!(["me"]));
        assert_eq!(p["milestone"], json!(3));
    }

    #[test]
    fn whitespace_title_is_refused() {
        assert_eq!(
            issue_payload(&input(" \n ", "", vec![], vec![], None)).unwrap_err(),
            "Title is required"
        );
    }

    #[test]
    fn created_issue_read_from_response() {
        let c =
            created_from(&json!({"number": 12, "html_url": "https://github.com/o/r/issues/12"}))
                .unwrap();
        assert_eq!(c.number, 12);
        assert_eq!(c.url, "https://github.com/o/r/issues/12");
    }

    #[test]
    fn created_issue_without_number_is_an_error() {
        assert!(created_from(&json!({})).is_err());
    }

    #[test]
    fn labels_keep_name_color_description() {
        let l = labels_from(&[
            json!({"name":"bug","color":"d73a4a","description":""}),
            json!({"color":"x"}),
        ]);
        assert_eq!(
            l,
            vec![RepoLabel {
                name: "bug".into(),
                color: "d73a4a".into(),
                description: None
            }]
        );
    }

    #[test]
    fn milestones_keep_number_title_due_date() {
        let m =
            milestones_from(&[json!({"number":3,"title":"v4","due_on":"2026-12-01T00:00:00Z"})]);
        assert_eq!(m[0].number, 3);
        assert_eq!(m[0].due_on.as_deref(), Some("2026-12-01T00:00:00Z"));
    }

    #[test]
    fn assignees_deduplicated_and_sorted() {
        let a = assignees_from(&[
            json!({"login":"zed"}),
            json!({"login":"Amy"}),
            json!({"login":"zed"}),
        ]);
        assert_eq!(
            a.iter().map(|x| x.login.as_str()).collect::<Vec<_>>(),
            ["Amy", "zed"]
        );
    }

    #[test]
    fn triage_rights_read_from_permissions() {
        let mut o = origin(true, true);
        o["permissions"] =
            json!({"admin": false, "maintain": false, "push": false, "triage": true, "pull": true});
        let mut p = parent(true);
        p["permissions"] = json!({"admin": false, "push": false, "triage": false, "pull": true});
        let t = targets_from(&o, Some(&p));
        assert!(t.targets[0].can_triage);
        assert!(!t.targets[1].can_triage);
    }

    #[test]
    fn push_rights_count_as_triage_and_missing_permissions_do_not() {
        let mut o = origin(true, false);
        o["permissions"] = json!({"push": true});
        assert!(targets_from(&o, None).targets[0].can_triage);
        assert!(!targets_from(&origin(true, false), None).targets[0].can_triage);
    }
}

//! Creating GitHub issues from inside GitWand (#301).
//!
//! An issue goes to `origin`'s GitHub repository or, on a fork, to its parent
//! (from the API's `parent`, never from an `upstream` remote: #298). Every
//! command that takes a `repo` checks it against those targets, recomputed
//! here, so the frontend cannot aim a write anywhere else.

use super::gh::{gh_api_on, gh_origin_repo, gh_signed_in_now, GhRepo};
use super::github_api::{
    rest_api_json, rest_api_json_cached, settings_github_token, with_rest_other_repo_using,
    with_rest_using,
};
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
        // An archived repository is read-only: it takes no new issue.
        has_issues: v
            .get("has_issues")
            .and_then(|b| b.as_bool())
            .unwrap_or(false)
            && !v.get("archived").and_then(|b| b.as_bool()).unwrap_or(false),
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
/// not mark the checkout restricted (see [`with_rest_other_repo_using`]).
fn api_call(
    cwd: &str,
    token: Option<&str>,
    repo: &GhRepo,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    // The same bound on both paths: a stalled read would hold the form on
    // "Checking…", a stalled POST would outlive the form's wait and invite a
    // retry that duplicates it.
    let secs: u32 = if method == "GET" { 30 } else { 60 };
    let rest = |tok: &str| rest_api_json(method, path, tok, body.as_deref(), Some(secs));
    let is_origin = gh_origin_repo(cwd).is_some_and(|o| same_repo(&o, repo));
    let attempt = if is_origin {
        with_rest_using(cwd, token, rest)
    } else {
        with_rest_other_repo_using(cwd, &repo.nwo, token, rest)
    };
    match attempt {
        Some(r) => r,
        None => gh_api_on(
            cwd,
            repo,
            method,
            path,
            body,
            Duration::from_secs(secs.into()),
        ),
    }
}

/// The same repository: same host, `owner/repo` compared without case (the
/// remote URL and the API's `full_name` may differ in case).
fn same_repo(a: &GhRepo, b: &GhRepo) -> bool {
    a.selector().eq_ignore_ascii_case(&b.selector())
}

/// `GET {path}` on `repo`'s host.
/// `token` is the Settings token, read once by the command (a keychain read
/// per page would be slow, and may prompt on macOS).
pub(crate) fn api_get(
    cwd: &str,
    token: Option<&str>,
    repo: &GhRepo,
    path: &str,
) -> Result<serde_json::Value, String> {
    api_call(cwd, token, repo, "GET", path, None)
}

const TARGETS_TTL: Duration = Duration::from_secs(5 * 60);

/// The Settings token for the issue commands, read from the keychain at most
/// every 30 s: opening the form runs the targets read and three picker
/// commands at once, and each keychain read is slow (and may prompt on
/// macOS). A sign-out is seen within 30 s; a sign-in at once (no token is
/// never cached).
fn issue_token() -> Option<String> {
    /// The token read (or its absence) and when.
    type TokenRead = (Option<String>, Instant);
    static CACHE: OnceLock<Mutex<Option<TokenRead>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((tok, at)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(30) {
                return tok.clone();
            }
        }
    }
    let tok = settings_github_token();
    // Only a token is kept: a sign-in from Settings is seen on the next call.
    if let (Some(_), Ok(mut guard)) = (&tok, cache.lock()) {
        *guard = Some((tok.clone(), Instant::now()));
    }
    tok
}

/// The issue targets of `cwd`, cached for five minutes per checkout *and*
/// `origin` (every form action re-validates against them; a changed `origin`
/// never reuses the previous one's targets). `fresh` reads them again, as the
/// form does when it opens. Empty when `origin` is not GitHub.
pub(crate) fn issue_targets_inner(
    cwd: &str,
    fresh: bool,
    token: Option<&str>,
) -> Result<IssueTargets, String> {
    type Cache = HashMap<(String, String), (IssueTargets, Instant)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Some(origin) = gh_origin_repo(cwd) else {
        return Ok(IssueTargets::default());
    };
    let key = (cwd.to_string(), origin.selector());
    if !fresh {
        if let Some((t, at)) = cache.lock().ok().and_then(|m| m.get(&key).cloned()) {
            if at.elapsed() < TARGETS_TTL {
                return Ok(t);
            }
        }
    }
    let o = api_get(cwd, token, &origin, &format!("repos/{}", origin.nwo))?;
    // The parent embedded in a fork's answer may lack the viewer's
    // `permissions` (and so its triage rights): read it on its own, keeping
    // the embedded copy when that read fails.
    let parent_name = o.pointer("/parent/full_name").and_then(|n| n.as_str());
    let parent = match parent_name.filter(|_| o.get("fork").and_then(|f| f.as_bool()) == Some(true))
    {
        Some(name) => api_get(
            cwd,
            token,
            &origin.sibling(name.to_string()),
            &format!("repos/{}", name),
        )
        .ok()
        .or_else(|| o.get("parent").cloned()),
        None => None,
    };
    let t = targets_from(&o, parent.as_ref());
    if let Ok(mut m) = cache.lock() {
        m.insert(key, (t.clone(), Instant::now()));
    }
    Ok(t)
}

/// `Ok` when `repo` is one of `targets` — with issues turned on when
/// `need_issues` (creating, reading labels and milestones).
fn check_target<'a>(
    targets: &'a IssueTargets,
    repo: &str,
    need_issues: bool,
) -> Result<&'a IssueTarget, String> {
    // GitHub names are case-insensitive (the remote URL and `full_name` may
    // differ in case), as in `same_repo`. The target found carries GitHub's
    // spelling, which the request then uses: one lookup for both.
    match targets
        .targets
        .iter()
        .find(|t| t.repo.eq_ignore_ascii_case(repo))
    {
        None => Err(format!("Not an issue target for this repository: {}", repo)),
        Some(t) if need_issues && !t.has_issues => Err(format!("Issues are disabled on {}", repo)),
        Some(t) => Ok(t),
    }
}

/// `repo` as a [`GhRepo`] on `origin`'s host, once checked against the
/// targets of `cwd`.
pub(crate) fn resolve_issue_target(
    cwd: &str,
    repo: &str,
    need_issues: bool,
    token: Option<&str>,
) -> Result<GhRepo, String> {
    let targets = issue_targets_inner(cwd, false, token)?;
    let canonical = check_target(&targets, repo, need_issues)?.repo.clone();
    let origin = gh_origin_repo(cwd).ok_or("No GitHub 'origin' remote in this repository.")?;
    Ok(origin.sibling(canonical))
}

/// Where an issue can be filed from `cwd` (#301), read fresh: the form calls
/// it when it opens.
#[tauri::command]
pub(crate) async fn gh_issue_targets(cwd: String) -> Result<IssueTargets, String> {
    tauri::async_runtime::spawn_blocking(move || {
        issue_targets_inner(&cwd, true, issue_token().as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether `cwd`'s `origin` is a GitHub repository: what shows the "New
/// issue" entry points. No GitHub API request: it reads the remote URL
/// (`gh_origin_repo`, cached 30 s), which for a host other than github.com
/// may ask `ssh -G` and `gh auth status` whether `gh` knows it — off the UI
/// thread. Whether issues are turned on is read when the form opens.
#[tauri::command]
pub(crate) async fn gh_issue_available(cwd: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || gh_origin_repo(&cwd).is_some())
        .await
        .map_err(|e| e.to_string())
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

/// Prefixed to a create error when the POST may have reached GitHub (it
/// timed out while waiting for the answer): the form then says the issue may
/// exist instead of offering a plain retry that could file it twice.
pub(crate) const MAY_HAVE_BEEN_CREATED: &str = "[may-have-been-created] ";

/// True for a failure after which GitHub may have filed the issue: a timeout
/// while waiting for the answer (curl `--max-time`, the `gh` call killed), the
/// connection dropped mid-answer (curl 52 empty reply, 56 receive failure,
/// 92 HTTP/2 stream), or a 5xx from GitHub's front end (the issue may be
/// created behind it). A connect timeout or an unresolved host means nothing
/// reached GitHub; a 4xx is GitHub's refusal.
fn post_may_have_landed(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    // curl (REST path).
    err.contains("Operation timed out")
        || ["(exit 52)", "(exit 56)", "(exit 92)"]
            .iter()
            .any(|c| err.contains(c))
        || ["(500)", "(502)", "(503)", "(504)"]
            .iter()
            .any(|c| err.starts_with("GitHub API error ") && err.contains(c))
        // `gh` (no Settings token): killed by its timeout, a 5xx without a
        // JSON answer, a connection dropped mid-answer.
        || err.starts_with("gh api: timed out")
        || ["(http 500)", "(http 502)", "(http 503)", "(http 504)", "http 502", "http 504"]
            .iter()
            .any(|c| lower.contains(c))
        || lower.contains("connection reset")
        || lower.contains("unexpected eof")
}

fn create_issue_inner(cwd: &str, input: &CreateIssueInput) -> Result<CreatedIssue, String> {
    // Checked before any call: a blank title costs no request.
    let payload = issue_payload(input)?.to_string();
    let token = issue_token();
    let token = token.as_deref();
    let repo = resolve_issue_target(cwd, &input.repo, true, token)?;
    let path = format!("repos/{}/issues", repo.nwo);
    match api_call(cwd, token, &repo, "POST", &path, Some(payload)) {
        Ok(created) => created_from(&created),
        Err(e) if post_may_have_landed(&e) => Err(format!("{}{}", MAY_HAVE_BEEN_CREATED, e)),
        Err(e) => Err(e),
    }
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

// ─── GitWand's own repository: resolver reports ────────────────────────────

/// Where a "bad resolution" report goes when the user sends it to GitWand
/// (#301): always github.com, whatever the current repository's forge or host.
pub(crate) const GITWAND_REPO: &str = "devlint/GitWand";

fn gitwand_repo() -> GhRepo {
    GhRepo::github_com(GITWAND_REPO)
}

/// A resolver report: a title and a body, nothing else (no triage rights on
/// GitWand's repository, so no labels, assignees or milestone).
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitwandIssueInput {
    pub(crate) title: String,
    pub(crate) body: String,
}

fn gitwand_payload(input: &GitwandIssueInput) -> Result<serde_json::Value, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Title is required".to_string());
    }
    Ok(serde_json::json!({ "title": title, "body": input.body }))
}

/// GitHub refused the Settings token itself (401 bad credentials, 403 not
/// allowed: a fine-grained PAT scoped to the user's own repositories, an org
/// restriction; 404: a token that cannot see the repository): nothing was
/// created, and `gh` may still be allowed.
fn token_refused(err: &str) -> bool {
    err.starts_with("GitHub API error ")
        && ["(401)", "(403)", "(404)"].iter().any(|c| err.contains(c))
}

fn create_gitwand_issue_inner(input: &GitwandIssueInput) -> Result<CreatedIssue, String> {
    let payload = gitwand_payload(input)?.to_string();
    let path = format!("repos/{}/issues", GITWAND_REPO);
    // Its own github.com path: the helpers behind `api_call` choose the token
    // and the host from the working directory's `origin`, which may be a
    // GitHub Enterprise host, another forge, or nothing at all.
    let via_gh = |payload: String| {
        gh_api_on(
            &std::env::temp_dir().to_string_lossy(),
            &gitwand_repo(),
            "POST",
            &path,
            Some(payload),
            Duration::from_secs(60),
        )
    };
    let attempt = match issue_token() {
        Some(tok) => match rest_api_json("POST", &path, &tok, Some(&payload), Some(60)) {
            // The token may not reach GitWand's repository where `gh` can.
            Err(e) if token_refused(&e) && gh_signed_in_now("github.com") => via_gh(payload),
            other => other,
        },
        None => via_gh(payload),
    };
    match attempt {
        Ok(created) => created_from(&created),
        Err(e) if post_may_have_landed(&e) => Err(format!("{}{}", MAY_HAVE_BEEN_CREATED, e)),
        Err(e) => Err(e),
    }
}

/// `gh_signed_in_now("github.com")`, reused for 30 s.
fn gh_github_com_signed_in() -> bool {
    static CACHE: OnceLock<Mutex<Option<(bool, Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((ok, at)) = cache.lock().ok().and_then(|g| *g) {
        if at.elapsed() < Duration::from_secs(30) {
            return ok;
        }
    }
    let ok = gh_signed_in_now("github.com");
    if let Ok(mut g) = cache.lock() {
        *g = Some((ok, Instant::now()));
    }
    ok
}

/// File a resolver report on GitWand's repository (#301).
#[tauri::command]
pub(crate) async fn gh_create_gitwand_issue(
    input: GitwandIssueInput,
) -> Result<CreatedIssue, String> {
    tauri::async_runtime::spawn_blocking(move || create_gitwand_issue_inner(&input))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a report can be written to GitWand's repository: a GitHub token in
/// Settings, else `gh` signed in to github.com. No API request.
#[tauri::command]
pub(crate) async fn gh_gitwand_writable() -> Result<bool, String> {
    // `gh auth status` is a process and a github.com round trip: reused for
    // 30 s (switching repository tabs), never for the session, so a
    // `gh auth login` since unlocks the switch without restarting the app.
    tauri::async_runtime::spawn_blocking(|| issue_token().is_some() || gh_github_com_signed_in())
        .await
        .map_err(|e| e.to_string())
}

// ─── Pickers: labels, milestones, assignees ────────────────────────────────

/// Pages of 100 from `fetch(page)`, up to `max_pages`, stopping at the first
/// short page: the one pagination loop of the issue and reviewer reads.
fn fetch_pages(
    max_pages: u32,
    mut fetch: impl FnMut(u32) -> Result<serde_json::Value, String>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut all = Vec::new();
    for page in 1..=max_pages {
        let arr = fetch(page)?.as_array().cloned().unwrap_or_default();
        let n = arr.len();
        all.extend(arr);
        if n < 100 {
            break;
        }
    }
    Ok(all)
}

/// Up to `max_pages` pages of 100 of the array at `path` (`query` ends with
/// `&` when given), REST or `gh` like [`api_get`].
pub(crate) fn api_get_pages(
    cwd: &str,
    token: Option<&str>,
    repo: &GhRepo,
    path: &str,
    query: &str,
    max_pages: u32,
) -> Result<Vec<serde_json::Value>, String> {
    fetch_pages(max_pages, |page| {
        let page_path = format!("{}?{}per_page=100&page={}", path, query, page);
        // Lists (labels, people, milestones) go through the ETag cache: an
        // unchanged page costs a 304 and no rate limit.
        let cached = |tok: &str| rest_api_json_cached(&page_path, tok);
        let attempt = if gh_origin_repo(cwd).is_some_and(|o| same_repo(&o, repo)) {
            with_rest_using(cwd, token, cached)
        } else {
            with_rest_other_repo_using(cwd, &repo.nwo, token, cached)
        };
        match attempt {
            Some(r) => r,
            None => gh_api_on(cwd, repo, "GET", &page_path, None, Duration::from_secs(30)),
        }
    })
}

/// Up to `max_pages` pages of 100 at `path`, over REST only, through the ETag
/// cache (a 304 costs no rate limit).
pub(crate) fn rest_pages(
    path: &str,
    token: &str,
    max_pages: u32,
) -> Result<Vec<serde_json::Value>, String> {
    fetch_pages(max_pages, |page| {
        rest_api_json_cached(&format!("{}?per_page=100&page={}", path, page), token)
    })
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
        let token = issue_token();
        let token = token.as_deref();
        let r = resolve_issue_target(&cwd, &repo, true, token)?;
        let items = api_get_pages(&cwd, token, &r, &format!("repos/{}/labels", r.nwo), "", 3)?;
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
        let token = issue_token();
        let token = token.as_deref();
        let r = resolve_issue_target(&cwd, &repo, true, token)?;
        let items = api_get_pages(
            &cwd,
            token,
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
        let token = issue_token();
        let token = token.as_deref();
        let r = resolve_issue_target(&cwd, &repo, true, token)?;
        let items = api_get_pages(
            &cwd,
            token,
            &r,
            &format!("repos/{}/assignees", r.nwo),
            "",
            3,
        )?;
        Ok(assignees_from(&items))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Issue templates (#301, part 5) ─────────────────────────

/// One template file of a target, as read: the frontend parses it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct TemplateFile {
    pub(crate) path: String,
    pub(crate) content: String,
}

/// A target's template files and the repository they were read from (the
/// target itself, or its owner's `.github` repository).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct IssueTemplateFiles {
    pub(crate) source: String,
    pub(crate) files: Vec<TemplateFile>,
    /// Every file listed was read: an incomplete set is not worth caching.
    pub(crate) complete: bool,
}

const TEMPLATE_DIR: &str = ".github/ISSUE_TEMPLATE";
/// GitHub's single-template locations, tried when the directory has none (the
/// file name in either case, as GitHub matches it).
const SINGLE_TEMPLATES: [&str; 6] = [
    ".github/ISSUE_TEMPLATE.md",
    ".github/issue_template.md",
    "ISSUE_TEMPLATE.md",
    "issue_template.md",
    "docs/ISSUE_TEMPLATE.md",
    "docs/issue_template.md",
];
const MAX_TEMPLATES: usize = 20;
const MAX_TEMPLATE_BYTES: u64 = 65_536;

/// `GET repos/{nwo}/contents/{path}` (`path` percent-encoded): `Ok(None)`
/// when it is not there. `Sync`: the files are read in parallel.
type ContentsGet<'a> = &'a (dyn Fn(&str, &str) -> Result<Option<serde_json::Value>, String> + Sync);
/// Whether a repository is public (GitHub only uses a public `.github` one).
type IsPublic<'a> = &'a (dyn Fn(&str) -> Result<bool, String> + Sync);

/// A GitHub error that means "not there" (REST: `(404)`, gh: `HTTP 404`), and
/// not a failure that merely mentions 404 (a repository named `error-404`).
pub(crate) fn is_not_found(e: &str) -> bool {
    // Anchored on the status, as `checks_unavailable` does: a path echoed in
    // gh's message (`crash (404).md`) is not a 404.
    e.starts_with("GitHub API error (404)") || e.contains("(HTTP 404)")
}

/// `path` with each segment percent-encoded: a file named `bug report.md` or
/// `a[b].yml` is a valid URL (curl refuses spaces and treats `[]` as a glob).
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(super::azure::urlenc)
        .collect::<Vec<_>>()
        .join("/")
}

/// A contents API file's text (its base64 is wrapped by GitHub).
fn decode_content(v: &serde_json::Value) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let b64: String = v
        .get("content")?
        .as_str()?
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    String::from_utf8(STANDARD.decode(b64).ok()?).ok()
}

fn small_enough(v: &serde_json::Value) -> bool {
    v.get("size")
        .and_then(|s| s.as_u64())
        .is_some_and(|s| s <= MAX_TEMPLATE_BYTES)
}

fn is_config_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    matches!(name.as_str(), "config.yml" | "config.yaml")
}

/// Read `paths` of `nwo`, at most 6 at a time on their own threads (network
/// waits, so not rayon's CPU pool); a file that cannot be read is skipped,
/// and the second value says whether every one was read.
fn read_files(nwo: &str, paths: &[String], get: ContentsGet) -> (Vec<TemplateFile>, bool) {
    let mut files = Vec::new();
    let mut complete = true;
    for chunk in paths.chunks(6) {
        let read: Vec<Option<TemplateFile>> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|path| {
                    scope.spawn(move || {
                        let content = get(nwo, &encode_path(path))
                            .ok()
                            .flatten()
                            .as_ref()
                            .and_then(decode_content)?;
                        Some(TemplateFile {
                            path: path.clone(),
                            content,
                        })
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().ok().flatten())
                .collect()
        });
        complete &= read.iter().all(|f| f.is_some());
        files.extend(read.into_iter().flatten());
    }
    (files, complete)
}

/// The first single-template file of `nwo`, probed in parallel (each probe a
/// request, often a `gh` spawn), in `SINGLE_TEMPLATES` order. A probe that
/// fails is skipped; the second value says whether every one answered.
fn single_template(nwo: &str, get: ContentsGet) -> (Option<TemplateFile>, bool) {
    let answers: Vec<Result<Option<serde_json::Value>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = SINGLE_TEMPLATES
            .iter()
            .map(|path| scope.spawn(move || get(nwo, path)))
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("template read panicked".into()))
            })
            .collect()
    });
    let complete = answers.iter().all(|a| a.is_ok());
    for (path, answer) in SINGLE_TEMPLATES.iter().zip(answers) {
        if let Ok(Some(v)) = answer {
            if let Some(content) = small_enough(&v).then(|| decode_content(&v)).flatten() {
                let file = TemplateFile {
                    path: path.to_string(),
                    content,
                };
                return (Some(file), complete);
            }
        }
    }
    (None, complete)
}

/// One repository's templates: the files, whether every one was read, and
/// whether the repository has any (GitHub then looks no further).
struct RepoTemplates {
    files: Vec<TemplateFile>,
    complete: bool,
    present: bool,
}

/// The template files of one repository. As GitHub: any file in its template
/// folder (`config.yml` included) makes that folder the whole answer, even if
/// some reads fail; only without one is a single-template file looked for.
/// Up to 20 templates by name, plus `config.yml`. The folder listing failing
/// fails; a file that cannot be read is skipped.
fn templates_in(nwo: &str, get: ContentsGet) -> Result<RepoTemplates, String> {
    if let Some(serde_json::Value::Array(items)) = get(nwo, TEMPLATE_DIR)? {
        // Every template-like file listed counts (GitHub looks no further);
        // only the small enough ones are read.
        let listed: Vec<&serde_json::Value> = items
            .iter()
            .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("file"))
            .filter(|i| {
                let name = i.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let lower = name.to_ascii_lowercase();
                [".md", ".yml", ".yaml"]
                    .iter()
                    .any(|ext| lower.ends_with(ext))
            })
            .collect();
        let present = !listed.is_empty();
        let mut named: Vec<(String, String)> = listed
            .into_iter()
            .filter(|i| small_enough(i))
            .filter_map(|i| {
                let name = i.get("name")?.as_str()?.to_string();
                let path = i.get("path")?.as_str()?.to_string();
                Some((name, path))
            })
            .collect();
        named.sort();
        let mut kept: Vec<(String, String)> = named
            .iter()
            .filter(|(_, p)| is_config_path(p))
            .cloned()
            .collect();
        kept.extend(
            named
                .iter()
                .filter(|(_, p)| !is_config_path(p))
                .take(MAX_TEMPLATES)
                .cloned(),
        );
        kept.sort();
        if present {
            let paths: Vec<String> = kept.into_iter().map(|(_, p)| p).collect();
            let (files, complete) = read_files(nwo, &paths, get);
            return Ok(RepoTemplates {
                files,
                complete,
                present,
            });
        }
    }
    let (single, complete) = single_template(nwo, get);
    Ok(RepoTemplates {
        present: single.is_some(),
        files: single.into_iter().collect(),
        complete,
    })
}

/// The templates of `nwo`, else of its owner's public `.github` repository
/// (GitHub's default community health files, `nwo`'s own `config.yml`
/// winning over theirs); none is an empty list.
pub(crate) fn template_files(
    nwo: &str,
    is_public: IsPublic,
    get: ContentsGet,
) -> Result<IssueTemplateFiles, String> {
    let own = templates_in(nwo, get)?;
    let mine = |complete: bool| IssueTemplateFiles {
        source: nwo.to_string(),
        files: own.files.clone(),
        complete,
    };
    // Only a repository with no template folder and no single template gets
    // its owner's (GitHub's default community health files).
    if own.present {
        return Ok(mine(own.complete));
    }
    let Some(owner) = nwo.split('/').next() else {
        return Ok(mine(own.complete));
    };
    let org = format!("{owner}/.github");
    if org.eq_ignore_ascii_case(nwo) {
        return Ok(mine(own.complete));
    }
    // A fallback: failing to read it (a 403 behind SSO, a rate limit) keeps
    // what `nwo` has, marked incomplete so it is not cached.
    let theirs = match is_public(&org).and_then(|public| {
        if public {
            templates_in(&org, get).map(Some)
        } else {
            Ok(None)
        }
    }) {
        Ok(t) => t,
        Err(_) => return Ok(mine(false)),
    };
    match theirs {
        Some(t) if t.present => Ok(IssueTemplateFiles {
            source: org,
            files: t.files,
            complete: own.complete && t.complete,
        }),
        _ => Ok(mine(own.complete)),
    }
}

/// The issue templates of a target (#301): what its blank form offers.
#[tauri::command]
pub(crate) async fn gh_issue_templates(
    cwd: String,
    repo: String,
) -> Result<IssueTemplateFiles, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = issue_token();
        let token = token.as_deref();
        let r = resolve_issue_target(&cwd, &repo, false, token)?;
        let get = |nwo: &str, path: &str| -> Result<Option<serde_json::Value>, String> {
            let on = r.sibling(nwo.to_string());
            match api_get(&cwd, token, &on, &format!("repos/{nwo}/contents/{path}")) {
                Ok(v) => Ok(Some(v)),
                Err(e) if is_not_found(&e) => Ok(None),
                Err(e) => Err(e),
            }
        };
        let is_public = |nwo: &str| -> Result<bool, String> {
            let on = r.sibling(nwo.to_string());
            match api_get(&cwd, token, &on, &format!("repos/{nwo}")) {
                Ok(v) => Ok(v.get("private").and_then(|p| p.as_bool()) == Some(false)),
                Err(e) if is_not_found(&e) => Ok(false),
                Err(e) => Err(e),
            }
        };
        template_files(&r.nwo, &is_public, &get)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A fake contents API: `(nwo, path)` → JSON, absent → 404.
    fn fake(
        entries: Vec<(&str, &str, serde_json::Value)>,
    ) -> impl Fn(&str, &str) -> Result<Option<serde_json::Value>, String> {
        let map: HashMap<(String, String), serde_json::Value> = entries
            .into_iter()
            .map(|(r, p, v)| ((r.to_string(), p.to_string()), v))
            .collect();
        move |nwo: &str, path: &str| Ok(map.get(&(nwo.to_string(), path.to_string())).cloned())
    }

    /// Every owner `.github` repository is public.
    const PUBLIC: fn(&str) -> Result<bool, String> = |_| Ok(true);

    fn file(content: &str) -> serde_json::Value {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        // GitHub wraps the base64 at 60 columns.
        let b64 = STANDARD.encode(content);
        let wrapped: Vec<String> = b64
            .as_bytes()
            .chunks(60)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect();
        json!({ "encoding": "base64", "content": wrapped.join("\n"), "size": content.len() })
    }

    fn entry(name: &str, size: usize) -> serde_json::Value {
        json!({ "name": name, "path": format!(".github/ISSUE_TEMPLATE/{name}"), "type": "file", "size": size })
    }

    #[test]
    fn templates_are_read_from_the_template_directory_sorted_and_capped() {
        let mut dir: Vec<serde_json::Value> = (0..22)
            .rev()
            .map(|i| entry(&format!("t{i:02}.md"), 10))
            .collect();
        dir.push(entry("config.yml", 10));
        dir.push(entry("notes.txt", 10));
        let mut entries = vec![("me/app", ".github/ISSUE_TEMPLATE", json!(dir))];
        let names: Vec<String> = (0..22)
            .map(|i| format!(".github/ISSUE_TEMPLATE/t{i:02}.md"))
            .collect();
        for n in &names {
            entries.push(("me/app", n.as_str(), file("body")));
        }
        entries.push((
            "me/app",
            ".github/ISSUE_TEMPLATE/config.yml",
            file("blank_issues_enabled: false"),
        ));
        let got = template_files("me/app", &PUBLIC, &fake(entries)).unwrap();
        assert_eq!(got.source, "me/app");
        let paths: Vec<&str> = got.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths.len(), 21);
        assert_eq!(paths[0], ".github/ISSUE_TEMPLATE/config.yml");
        assert_eq!(paths[1], ".github/ISSUE_TEMPLATE/t00.md");
        assert_eq!(paths[20], ".github/ISSUE_TEMPLATE/t19.md");
        assert!(!paths.iter().any(|p| p.ends_with(".txt")));
        assert_eq!(got.files[1].content, "body");
    }

    #[test]
    fn a_file_over_64_kib_is_skipped() {
        let dir = json!([entry("big.md", 65_537), entry("ok.yml", 10)]);
        let got = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![
                ("me/app", ".github/ISSUE_TEMPLATE", dir),
                ("me/app", ".github/ISSUE_TEMPLATE/ok.yml", file("name: ok")),
            ]),
        )
        .unwrap();
        let paths: Vec<&str> = got.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".github/ISSUE_TEMPLATE/ok.yml"]);
    }

    #[test]
    fn falls_back_to_the_single_template_files_then_the_owner_dot_github_repo() {
        let single = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![("me/app", "docs/ISSUE_TEMPLATE.md", file("legacy"))]),
        )
        .unwrap();
        assert_eq!(single.source, "me/app");
        assert_eq!(single.files[0].path, "docs/ISSUE_TEMPLATE.md");
        let org = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![
                (
                    "me/.github",
                    ".github/ISSUE_TEMPLATE",
                    json!([entry("bug.yml", 10)]),
                ),
                (
                    "me/.github",
                    ".github/ISSUE_TEMPLATE/bug.yml",
                    file("name: Bug"),
                ),
            ]),
        )
        .unwrap();
        assert_eq!(org.source, "me/.github");
        assert_eq!(org.files[0].content, "name: Bug");
    }

    #[test]
    fn a_file_name_with_a_space_or_brackets_is_percent_encoded() {
        let dir = json!([entry("bug report.md", 10), entry("a[b].yml", 10)]);
        let got = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![
                ("me/app", ".github/ISSUE_TEMPLATE", dir),
                (
                    "me/app",
                    ".github/ISSUE_TEMPLATE/bug%20report.md",
                    file("a"),
                ),
                ("me/app", ".github/ISSUE_TEMPLATE/a%5Bb%5D.yml", file("b")),
            ]),
        )
        .unwrap();
        let paths: Vec<&str> = got.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                ".github/ISSUE_TEMPLATE/a[b].yml",
                ".github/ISSUE_TEMPLATE/bug report.md"
            ]
        );
    }

    #[test]
    fn one_file_that_fails_is_skipped_the_others_kept() {
        let dir = json!([entry("a.md", 10), entry("b.md", 10)]);
        let get = |nwo: &str, path: &str| -> Result<Option<serde_json::Value>, String> {
            match path {
                ".github/ISSUE_TEMPLATE" => Ok(Some(dir.clone())),
                ".github/ISSUE_TEMPLATE/a.md" => Err("curl: (28) timed out".into()),
                _ if nwo == "me/app" => Ok(Some(file("b"))),
                _ => Ok(None),
            }
        };
        let got = template_files("me/app", &PUBLIC, &get).unwrap();
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].path, ".github/ISSUE_TEMPLATE/b.md");
    }

    #[test]
    fn a_private_owner_dot_github_repository_is_not_used() {
        let private = |_: &str| -> Result<bool, String> { Ok(false) };
        let got = template_files(
            "me/app",
            &private,
            &fake(vec![
                (
                    "me/.github",
                    ".github/ISSUE_TEMPLATE",
                    json!([entry("bug.yml", 10)]),
                ),
                (
                    "me/.github",
                    ".github/ISSUE_TEMPLATE/bug.yml",
                    file("name: Bug"),
                ),
            ]),
        )
        .unwrap();
        assert!(got.files.is_empty());
    }

    #[test]
    fn only_a_real_404_counts_as_absent() {
        assert!(is_not_found("GitHub API error (404): Not Found"));
        assert!(is_not_found("gh: Not Found (HTTP 404)"));
        assert!(!is_not_found(
            "gh api GET repos/acme/error-404-page/contents/x: network down"
        ));
        assert!(!is_not_found(
            "gh api GET repos/o/r/contents/crash (404).md: HTTP 502"
        ));
    }

    #[test]
    fn any_file_in_the_template_folder_rules_out_the_other_places() {
        // GitHub: any file there, config.yml included, and neither the single
        // template nor the owner's .github repository is used.
        let got = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![
                (
                    "me/app",
                    ".github/ISSUE_TEMPLATE",
                    json!([entry("config.yml", 10)]),
                ),
                (
                    "me/app",
                    ".github/ISSUE_TEMPLATE/config.yml",
                    file("blank_issues_enabled: false"),
                ),
                ("me/app", ".github/ISSUE_TEMPLATE.md", file("legacy")),
                (
                    "me/.github",
                    ".github/ISSUE_TEMPLATE",
                    json!([entry("bug.yml", 10)]),
                ),
                (
                    "me/.github",
                    ".github/ISSUE_TEMPLATE/bug.yml",
                    file("name: Bug"),
                ),
            ]),
        )
        .unwrap();
        assert_eq!(got.source, "me/app");
        let paths: Vec<&str> = got.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".github/ISSUE_TEMPLATE/config.yml"]);
    }

    #[test]
    fn templates_listed_but_unreadable_never_fall_back_to_the_owner() {
        let get = |nwo: &str, path: &str| -> Result<Option<serde_json::Value>, String> {
            match (nwo, path) {
                ("me/app", ".github/ISSUE_TEMPLATE") => Ok(Some(json!([entry("bug.yml", 10)]))),
                ("me/app", _) => Err("curl: (28) timed out".into()),
                _ => Ok(Some(json!([entry("x.yml", 10)]))),
            }
        };
        let got = template_files("me/app", &PUBLIC, &get).unwrap();
        assert_eq!(got.source, "me/app");
        assert!(got.files.is_empty());
        assert!(!got.complete);
    }

    #[test]
    fn a_failing_single_template_probe_is_skipped_not_fatal() {
        let get = |_: &str, path: &str| -> Result<Option<serde_json::Value>, String> {
            match path {
                ".github/ISSUE_TEMPLATE.md" => Err("GitHub API error (502): Bad gateway".into()),
                "docs/ISSUE_TEMPLATE.md" => Ok(Some(file("docs"))),
                _ => Ok(None),
            }
        };
        let got = template_files("me/app", &PUBLIC, &get).unwrap();
        assert_eq!(got.files[0].path, "docs/ISSUE_TEMPLATE.md");
        assert!(!got.complete);
    }

    #[test]
    fn a_lowercase_single_template_file_is_found() {
        let got = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![("me/app", ".github/issue_template.md", file("lower"))]),
        )
        .unwrap();
        assert_eq!(got.files[0].path, ".github/issue_template.md");
    }

    #[test]
    fn a_failing_owner_dot_github_keeps_what_the_repository_has() {
        let get = |nwo: &str, _: &str| -> Result<Option<serde_json::Value>, String> {
            if nwo == "me/.github" {
                return Err("GitHub API error (403): SSO required".into());
            }
            Ok(None)
        };
        let got = template_files("me/app", &PUBLIC, &get).unwrap();
        assert!(got.files.is_empty());
        // Not cached: the fallback is tried again next time.
        assert!(!got.complete);
    }

    #[test]
    fn a_set_with_an_unreadable_file_is_marked_incomplete() {
        let dir = json!([entry("a.md", 10), entry("b.md", 10)]);
        let get = |_: &str, path: &str| -> Result<Option<serde_json::Value>, String> {
            match path {
                ".github/ISSUE_TEMPLATE" => Ok(Some(dir.clone())),
                ".github/ISSUE_TEMPLATE/a.md" => Err("curl: (28) timed out".into()),
                _ => Ok(Some(file("b"))),
            }
        };
        let got = template_files("me/app", &PUBLIC, &get).unwrap();
        assert_eq!(got.files.len(), 1);
        assert!(!got.complete);
        let all = template_files(
            "me/app",
            &PUBLIC,
            &fake(vec![("me/app", "docs/ISSUE_TEMPLATE.md", file("x"))]),
        )
        .unwrap();
        assert!(all.complete);
    }

    #[test]
    fn nothing_anywhere_is_an_empty_list() {
        let got = template_files("me/app", &PUBLIC, &fake(vec![])).unwrap();
        assert!(got.files.is_empty());
    }

    #[test]
    fn a_non_404_error_fails_the_read() {
        let failing = |_: &str, _: &str| -> Result<Option<serde_json::Value>, String> {
            Err("GitHub API error (502): Bad gateway".into())
        };
        assert!(template_files("me/app", &PUBLIC, &failing).is_err());
    }

    #[test]
    fn a_refused_token_falls_back_to_gh() {
        assert!(token_refused(
            "GitHub API error (403): Resource not accessible by personal access token"
        ));
        assert!(token_refused("GitHub API error (401): Bad credentials"));
        assert!(token_refused("GitHub API error (404): Not Found"));
        assert!(!token_refused("GitHub API error (422): Validation Failed"));
        assert!(!token_refused("GitHub API error (502): Bad gateway"));
        assert!(!token_refused("Operation timed out"));
    }

    #[test]
    fn gitwand_repo_is_on_github_com() {
        let r = gitwand_repo();
        assert_eq!(r.selector(), "devlint/GitWand");
        assert_eq!(r.enterprise_host(), None);
    }

    #[test]
    fn gitwand_payload_is_title_and_body_only() {
        let input = GitwandIssueInput {
            title: " Resolver: bad resolution ".into(),
            body: "b".into(),
        };
        assert_eq!(
            gitwand_payload(&input).unwrap(),
            json!({"title": "Resolver: bad resolution", "body": "b"})
        );
        let blank = GitwandIssueInput {
            title: "  ".into(),
            body: "b".into(),
        };
        assert!(gitwand_payload(&blank).is_err());
    }

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

    #[test]
    fn same_repo_ignores_case_but_not_host_or_name() {
        let a = GhRepo::for_test("", "devlint/gitwand");
        assert!(same_repo(&a, &GhRepo::for_test("", "devlint/GitWand")));
        assert!(!same_repo(
            &a,
            &GhRepo::for_test("ghe.example.com/", "devlint/gitwand")
        ));
        assert!(!same_repo(&a, &GhRepo::for_test("", "devlint/other")));
    }

    #[test]
    fn a_target_matches_whatever_the_case() {
        let t = targets_from(&origin(true, false), None);
        assert!(check_target(&t, "ME/App", true).is_ok());
    }

    #[test]
    fn only_a_timeout_after_sending_may_have_created_the_issue() {
        // curl --max-time while waiting for the answer: the POST left.
        assert!(post_may_have_landed(
            "curl request failed (exit 28): Operation timed out after 60001 milliseconds with 0 bytes received"
        ));
        // The gh path killed by its timeout, after spawning the request.
        assert!(post_may_have_landed("gh api: timed out after 60s"));
        // Never connected: nothing reached GitHub.
        assert!(!post_may_have_landed(
            "curl request failed (exit 28): Connection timed out after 20001 milliseconds"
        ));
        assert!(!post_may_have_landed(
            "curl request failed (exit 28): Failed to connect to api.github.com port 443 after 20002 ms: Timeout was reached"
        ));
        assert!(!post_may_have_landed(
            "GitHub API error (422): Validation Failed"
        ));
    }

    #[test]
    fn check_target_gives_githubs_spelling() {
        let t = targets_from(&origin(true, false), None);
        assert_eq!(check_target(&t, "ME/APP", true).unwrap().repo, "me/app");
    }

    #[test]
    fn a_failure_after_sending_may_have_created_the_issue() {
        for err in [
            "GitHub API error (502): Server Error",
            "GitHub API error (504): HTTP 504",
            "curl request failed (exit 56): Recv failure: Connection reset by peer",
            "curl request failed (exit 52): Empty reply from server",
            "curl request failed (exit 92): HTTP/2 stream 1 was not closed cleanly",
        ] {
            assert!(post_may_have_landed(err), "{err}");
        }
        assert!(!post_may_have_landed("GitHub API error (403): Forbidden"));
        assert!(!post_may_have_landed(
            "curl request failed (exit 6): Could not resolve host"
        ));
    }

    #[test]
    fn an_archived_repository_takes_no_issue() {
        let mut o = origin(true, false);
        o["archived"] = json!(true);
        let t = targets_from(&o, None);
        assert!(!t.targets[0].has_issues);
        assert_eq!(t.default_repo, None);
    }

    #[test]
    fn pages_stop_on_a_short_page_and_at_the_cap() {
        let mut asked = Vec::new();
        let items = fetch_pages(3, |page| {
            asked.push(page);
            Ok(json!(vec![
                json!({"n": page});
                if page < 2 { 100 } else { 5 }
            ]))
        })
        .unwrap();
        assert_eq!(asked, [1, 2]);
        assert_eq!(items.len(), 105);
        let mut asked = Vec::new();
        fetch_pages(2, |page| {
            asked.push(page);
            Ok(json!(vec![json!({}); 100]))
        })
        .unwrap();
        assert_eq!(asked, [1, 2]);
    }

    #[test]
    fn gh_path_failures_after_sending_may_have_created_the_issue() {
        for err in [
            "gh api POST repos/o/r/issues: gh: Bad Gateway (HTTP 502)",
            "gh api POST repos/o/r/issues: gh: HTTP 504",
            "gh api POST repos/o/r/issues: Post \"https://api.github.com/repos/o/r/issues\": read tcp: connection reset by peer",
            "gh api POST repos/o/r/issues: Post \"…\": unexpected EOF",
        ] {
            assert!(post_may_have_landed(err), "{err}");
        }
        assert!(!post_may_have_landed(
            "gh api POST repos/o/r/issues: gh: Not Found (HTTP 404)"
        ));
    }
}

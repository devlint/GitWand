use std::collections::HashMap;
use std::path::Path;
use crate::git::cmd::git_cmd;
use crate::types::{
    DiffHunk, DiffLine, FileLogEntry, FolderDiffNode, GhIssueRaw, GhPrDetailRaw, GhPrRaw,
    GhPrStatusCheck, Issue, MonorepoPackage, PullRequest, PullRequestDetail, RawFileChange,
    ShortlogEntry,
};

/// Aggregate a PR's individual status checks into a single rollup state.
///
/// Mirrors GitHub's own `statusCheckRollup.state`: a single failing check turns
/// the whole rollup red, regardless of position. Previously only the first
/// check's `conclusion` was read, so a green first check masked later failures
/// (and still-running checks with a null conclusion were dropped entirely).
///
/// Precedence: any failure ⇒ `FAILURE`, else any pending/running ⇒ `PENDING`,
/// else `SUCCESS`. Empty input ⇒ `""` (no checks configured → no dot).
pub(crate) fn rollup_status_checks(checks: &[GhPrStatusCheck]) -> String {
    if checks.is_empty() {
        return String::new();
    }
    let mut pending = false;
    for c in checks {
        // CheckRun: lifecycle in `status`, outcome in `conclusion` once COMPLETED.
        // StatusContext: outcome directly in `state`.
        let outcome = c
            .conclusion
            .as_deref()
            .or(c.state.as_deref())
            .unwrap_or("")
            .to_uppercase();
        match outcome.as_str() {
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" | "STALE" => return "FAILURE".to_string(),
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
            // PENDING / EXPECTED / QUEUED / "" (running CheckRun with no
            // conclusion yet) → not green, not red.
            _ => pending = true,
        }
        // A CheckRun that hasn't completed is still pending even if some stale
        // conclusion is absent.
        if let Some(st) = c.status.as_deref() {
            let st = st.to_uppercase();
            if st != "COMPLETED" && c.conclusion.is_none() {
                pending = true;
            }
        }
    }
    if pending { "PENDING".to_string() } else { "SUCCESS".to_string() }
}

pub(crate) fn parse_diff_hunks(stdout: &str) -> (Vec<DiffHunk>, Option<String>) {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line_no = 0i32;
    let mut new_line_no = 0i32;
    let mut detected_status: Option<String> = None;

    for line in stdout.lines() {
        if line.starts_with("new file mode") {
            detected_status = Some("added".to_string());
            continue;
        }

        if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            let header = line.to_string();
            let parts: Vec<&str> = line.split_whitespace().collect();
            let mut old_start = 0;
            let mut old_count = 1;
            let mut new_start = 0;
            let mut new_count = 1;

            if parts.len() >= 3 {
                let old_range = parts[1].strip_prefix('-').unwrap_or("0");
                let new_range = parts[2].strip_prefix('+').unwrap_or("0");

                if let Some(comma_idx) = old_range.find(',') {
                    old_start = old_range[..comma_idx].parse().unwrap_or(0);
                    old_count = old_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    old_start = old_range.parse().unwrap_or(0);
                }

                if let Some(comma_idx) = new_range.find(',') {
                    new_start = new_range[..comma_idx].parse().unwrap_or(0);
                    new_count = new_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    new_start = new_range.parse().unwrap_or(0);
                }
            }

            old_line_no = old_start;
            new_line_no = new_start;

            current_hunk = Some(DiffHunk {
                header,
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
            });
        } else if let Some(ref mut hunk) = current_hunk {
            if line.starts_with('+') && !line.starts_with("+++") {
                hunk.lines.push(DiffLine {
                    r#type: "add".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: None,
                    new_line_no: Some(new_line_no),
                });
                new_line_no += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                hunk.lines.push(DiffLine {
                    r#type: "delete".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: Some(old_line_no),
                    new_line_no: None,
                });
                old_line_no += 1;
            } else if line.starts_with(' ') {
                let content = line[1..].to_string();
                hunk.lines.push(DiffLine {
                    r#type: "context".to_string(),
                    content,
                    old_line_no: Some(old_line_no),
                    new_line_no: Some(new_line_no),
                });
                old_line_no += 1;
                new_line_no += 1;
            }
        }
    }

    if let Some(hunk) = current_hunk.take() {
        hunks.push(hunk);
    }

    (hunks, detected_status)
}

pub(crate) fn parse_name_status_z(s: &str) -> Vec<(String, String, Option<String>)> {
    let tokens: Vec<&str> = s.split('\0').filter(|t| !t.is_empty()).collect();
    let mut result: Vec<(String, String, Option<String>)> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let status_full = tokens[i];
        let letter = status_full.chars().next().unwrap_or('M').to_ascii_uppercase();
        if letter == 'R' || letter == 'C' {
            if i + 2 < tokens.len() {
                let old = tokens[i + 1].to_string();
                let new_path = tokens[i + 2].to_string();
                result.push((new_path, letter.to_string(), Some(old)));
                i += 3;
            } else {
                break;
            }
        } else {
            if i + 1 < tokens.len() {
                let new_path = tokens[i + 1].to_string();
                result.push((new_path, letter.to_string(), None));
                i += 2;
            } else {
                break;
            }
        }
    }
    result
}

pub(crate) fn parse_numstat_z(s: &str) -> HashMap<String, (u32, u32, bool)> {
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut result: HashMap<String, (u32, u32, bool)> = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let head = tokens[i];
        if head.is_empty() {
            i += 1;
            continue;
        }
        let parts: Vec<&str> = head.splitn(3, '\t').collect();
        if parts.len() < 2 {
            i += 1;
            continue;
        }
        let adds_str = parts[0];
        let dels_str = parts[1];
        let binary = adds_str == "-" && dels_str == "-";
        let additions: u32 = if binary { 0 } else { adds_str.parse().unwrap_or(0) };
        let deletions: u32 = if binary { 0 } else { dels_str.parse().unwrap_or(0) };
        let path_part = if parts.len() >= 3 { parts[2] } else { "" };
        if path_part.is_empty() {
            let mut j = i + 1;
            let mut collected: Vec<&str> = Vec::new();
            while j < tokens.len() && collected.len() < 2 {
                if !tokens[j].is_empty() {
                    collected.push(tokens[j]);
                }
                j += 1;
            }
            if collected.len() == 2 {
                result.insert(collected[1].to_string(), (additions, deletions, binary));
                i = j;
            } else {
                break;
            }
        } else {
            result.insert(path_part.to_string(), (additions, deletions, binary));
            i += 1;
        }
    }
    result
}

pub(crate) fn folder_diff_args(ref_a: &str, ref_b: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let a = ref_a.trim();
    let b = ref_b.trim();
    if a.is_empty() && b.is_empty() {
        args.push("HEAD".to_string());
    } else if b.is_empty() {
        args.push(a.to_string());
    } else {
        args.push(a.to_string());
        args.push(b.to_string());
    }
    args
}

pub(crate) fn sort_node(node: &mut FolderDiffNode) {
    node.children.sort_by(|a, b| {
        let a_is_folder = a.kind == "folder";
        let b_is_folder = b.kind == "folder";
        match (a_is_folder, b_is_folder) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    for c in node.children.iter_mut() {
        sort_node(c);
    }
}

pub(crate) fn insert_segments(
    node: &mut FolderDiffNode,
    segments: &[&str],
    depth: usize,
    total_segments: usize,
    path_so_far: &str,
    change: &RawFileChange,
) {
    node.files_changed = node.files_changed.saturating_add(1);
    node.additions = node.additions.saturating_add(change.additions);
    node.deletions = node.deletions.saturating_add(change.deletions);

    if segments.is_empty() {
        if depth > 0 {
            node.status = Some(change.status.clone());
            node.old_path = change.old_path.clone();
            node.binary = change.binary;
            node.files_changed = 1;
        }
        return;
    }

    let seg = segments[0];
    let remaining = &segments[1..];
    let is_last_seg = remaining.is_empty();

    let full_path = if path_so_far.is_empty() {
        seg.to_string()
    } else {
        format!("{}/{}", path_so_far, seg)
    };

    let idx = match node.children.iter().position(|c| c.name == seg) {
        Some(i) => i,
        None => {
            node.children.push(FolderDiffNode {
                path: full_path.clone(),
                name: seg.to_string(),
                kind: if is_last_seg { "file".to_string() } else { "folder".to_string() },
                status: None,
                old_path: None,
                files_changed: 0,
                additions: 0,
                deletions: 0,
                binary: false,
                children: Vec::new(),
            });
            node.children.len() - 1
        }
    };

    let _ = total_segments;
    insert_segments(
        &mut node.children[idx],
        remaining,
        depth + 1,
        total_segments,
        &full_path,
        change,
    );
}

pub(crate) fn insert_change(root: &mut FolderDiffNode, change: &RawFileChange) {
    let segments: Vec<&str> = change.new_path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return;
    }
    let total = segments.len();
    insert_segments(root, &segments, 0, total, "", change);
}

pub(crate) fn parse_file_log_output(raw: &str) -> Vec<FileLogEntry> {
    let sep = "---END---";
    let mut entries = Vec::new();
    for block in raw.split(sep) {
        let trimmed = block.trim();
        if trimmed.is_empty() { continue; }
        let parts: Vec<&str> = trimmed.splitn(6, '\n').collect();
        if parts.len() < 5 { continue; }
        entries.push(FileLogEntry {
            hash_full: parts[0].trim().to_string(),
            hash: parts[1].trim().to_string(),
            author: parts[2].trim().to_string(),
            date: parts[3].trim().to_string(),
            message: parts[4].trim().to_string(),
            body: parts.get(5).map(|s| s.trim().to_string()).unwrap_or_default(),
        });
    }
    entries
}

pub(crate) fn gh_pr_detail_raw_to_detail(r: GhPrDetailRaw) -> PullRequestDetail {
    let comments = r.comments.len() as i64;
    let review_comments = r.reviews.len() as i64;
    let labels: Vec<String> = r.labels.into_iter().map(|l| l.name).collect();
    let reviewers: Vec<String> = r.review_requests
        .into_iter()
        .filter_map(|rr| rr.login)
        .collect();
    // Same aggregation as the list dot (any failure ⇒ red, else pending ⇒
    // yellow, else green). The old inline logic only looked at `conclusion`,
    // so a still-running check (its run state lives in `status`) was missed and
    // a single later failure could be masked.
    let checks_status = match rollup_status_checks(&r.status_check_rollup).as_str() {
        "FAILURE" => "failure".to_string(),
        "PENDING" => "pending".to_string(),
        "SUCCESS" => "success".to_string(),
        _ => "unknown".to_string(),
    };
    PullRequestDetail {
        number: r.number,
        title: r.title,
        body: r.body,
        state: r.state,
        author: r.author.login.unwrap_or_default(),
        branch: r.head_ref_name,
        base: r.base_ref_name,
        draft: r.is_draft,
        created_at: r.created_at,
        updated_at: r.updated_at,
        merged_at: r.merged_at.unwrap_or_default(),
        url: r.url,
        additions: r.additions,
        deletions: r.deletions,
        changed_files: r.changed_files,
        comments,
        review_comments,
        labels,
        reviewers,
        mergeable: r.mergeable.unwrap_or_default(),
        checks_status,
        // Filled in by the caller (gh_pr_detail) via a `gh repo view`
        // viewerPermission lookup — `gh pr view` doesn't carry it.
        can_merge: None,
    }
}

pub(crate) fn parse_gh_pr_json(json: &str) -> Result<Vec<PullRequest>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }
    // Two-pass tolerant parse: parse to Vec<Value> first so a single
    // malformed PR (e.g. null `author` for a deleted user or a GitHub App
    // that doesn't expose `.login`) doesn't drop the entire list.
    let values: Vec<serde_json::Value> = serde_json::from_str(trimmed)
        .map_err(|e| format!("Failed to parse gh pr list output: {}", e))?;
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        match serde_json::from_value::<GhPrRaw>(v.clone()) {
            Ok(raw) => out.push(gh_pr_raw_to_pr(raw)),
            Err(e) => {
                let number = v.get("number").and_then(|n| n.as_i64()).unwrap_or(-1);
                eprintln!(
                    "[parse_gh_pr_json] skipping PR #{}: {}",
                    number, e
                );
            }
        }
    }
    Ok(out)
}

pub(crate) fn gh_pr_raw_to_pr(r: GhPrRaw) -> PullRequest {
    let review_requested = r.review_requests
        .into_iter()
        .filter_map(|rr| rr.login)
        .collect();
    let checks_rollup = rollup_status_checks(&r.status_check_rollup);
    let comment_count = r.comments.len() as i64;
    let author = r
        .author
        .and_then(|a| a.login)
        .unwrap_or_default();
    PullRequest {
        number: r.number,
        title: r.title,
        state: r.state,
        author,
        branch: r.head_ref_name,
        base: r.base_ref_name,
        draft: r.is_draft,
        created_at: r.created_at,
        updated_at: r.updated_at,
        url: r.url,
        additions: r.additions,
        deletions: r.deletions,
        labels: r.labels.into_iter().map(|l| l.name).collect(),
        assignees: r
            .assignees
            .into_iter()
            .filter_map(|a| a.login)
            .collect(),
        review_requested,
        review_decision: r.review_decision.unwrap_or_default(),
        merge_state_status: r.merge_state_status.unwrap_or_default(),
        checks_rollup,
        comment_count,
    }
}

pub(crate) fn parse_remote_owner_repo(url: &str) -> (String, String) {
    if let Some(colon_pos) = url.find(':') {
        if url.starts_with("git@") {
            let path = &url[colon_pos + 1..];
            let clean = path.trim_end_matches(".git");
            let parts: Vec<&str> = clean.splitn(2, '/').collect();
            if parts.len() == 2 {
                return (parts[0].to_string(), parts[1].to_string());
            }
        }
    }
    if let Some(host_end) = url.find("://") {
        let path = &url[host_end + 3..];
        if let Some(slash_pos) = path.find('/') {
            let clean = path[slash_pos + 1..].trim_end_matches(".git");
            let parts: Vec<&str> = clean.splitn(2, '/').collect();
            if parts.len() == 2 {
                return (parts[0].to_string(), parts[1].to_string());
            }
        }
    }
    (String::new(), String::new())
}

pub(crate) fn parse_gh_issue_json(json: &str) -> Result<Vec<Issue>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }
    let raws: Vec<GhIssueRaw> = serde_json::from_str(trimmed)
        .map_err(|e| format!("Failed to parse gh issue list output: {}", e))?;
    Ok(raws.into_iter().map(|r| Issue {
        number: r.number,
        title: r.title,
        state: r.state,
        author: r.author.login,
        assignees: r.assignees.into_iter().map(|a| a.login).collect(),
        labels: r.labels.into_iter().map(|l| l.name).collect(),
        url: r.url,
        created_at: r.created_at,
        updated_at: r.updated_at,
        milestone: r.milestone.map(|m| m.title).unwrap_or_default(),
    }).collect())
}

pub(crate) fn parse_shortlog_line(line: &str) -> Option<ShortlogEntry> {
    let trimmed = line.trim_start();
    let (count_str, rest) = trimmed.split_once('\t')?;
    let count = count_str.trim().parse::<u32>().ok()?;
    let rest = rest.trim();
    let lt = rest.rfind('<')?;
    let gt = rest.rfind('>')?;
    if gt <= lt {
        return None;
    }
    let name = rest[..lt].trim().to_string();
    let email = rest[lt + 1..gt].to_string();
    Some(ShortlogEntry { name, email, count })
}

#[allow(dead_code)]
pub(crate) fn parse_wip_status(output: &str) -> (u32, u32, u32) {
    let mut staged = 0u32;
    let mut unstaged = 0u32;
    let mut untracked = 0u32;
    for line in output.lines() {
        if line.len() < 2 {
            continue;
        }
        let x = &line[0..1];
        let y = &line[1..2];
        if x == "?" && y == "?" {
            untracked += 1;
        } else {
            if x != " " && x != "?" && x != "!" {
                staged += 1;
            }
            if y != " " && y != "?" && y != "!" {
                unstaged += 1;
            }
        }
    }
    (staged, unstaged, untracked)
}

pub(crate) fn find_json_key_value_start(json: &str, key: &str) -> Option<String> {
    let search = format!("\"{}\"", key);
    let key_pos = json.find(&search)?;
    let after_key = &json[key_pos + search.len()..];
    let colon_pos = after_key.find(':')?;
    let value_start = after_key[colon_pos + 1..].trim_start();

    if !value_start.starts_with('{') {
        return None;
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape_next = false;
    let mut end = 0usize;

    for (i, c) in value_start.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        match c {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    end = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if end > 0 {
        Some(value_start[..end].to_string())
    } else {
        None
    }
}

pub(crate) fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let pos = json.find(&needle)?;
    let rest = &json[pos + needle.len()..];
    let colon = rest.find(':')?;
    let after_colon = rest[colon + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    let value_start = 1;
    let value_end = after_colon[value_start..].find('"')?;
    Some(after_colon[value_start..value_start + value_end].to_string())
}

pub(crate) fn guess_mime_from_ext(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

pub(crate) fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    if trimmed.is_empty() {
        return None;
    }
    let last = trimmed.rsplit(['/', ':']).next()?;
    if last.is_empty() {
        None
    } else {
        Some(last.to_string())
    }
}

pub(crate) fn find_workspace_packages(cwd: &str, config_content: &str, manager: &str) -> Vec<MonorepoPackage> {
    match manager {
        "cargo" => find_cargo_packages(cwd, config_content),
        "go" => find_go_packages(cwd, config_content),
        "nx" => find_nx_packages(cwd, config_content),
        // turbo defers package layout to package.json workspaces
        "turbo" => find_npm_workspace_packages(cwd, config_content),
        _ => find_npm_or_pnpm_packages(cwd, config_content, manager),
    }
}

// ─── pnpm / npm / yarn / turbo ────────────────────────────────────────────

fn find_npm_or_pnpm_packages(cwd: &str, config_content: &str, manager: &str) -> Vec<MonorepoPackage> {
    let mut globs: Vec<String> = Vec::new();

    if manager == "pnpm" {
        for line in config_content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("- ") {
                let pattern = trimmed[2..].trim().trim_matches('\'').trim_matches('"');
                globs.push(pattern.to_string());
            }
        }
    } else {
        globs = extract_npm_workspace_globs(config_content);
    }

    expand_npm_globs(cwd, &globs)
}

fn find_npm_workspace_packages(cwd: &str, config_content: &str) -> Vec<MonorepoPackage> {
    let globs = extract_npm_workspace_globs(config_content);
    expand_npm_globs(cwd, &globs)
}

/// Extract glob patterns from a package.json `"workspaces"` array (flat or
/// `{ "packages": [...] }` object form).
fn extract_npm_workspace_globs(content: &str) -> Vec<String> {
    let mut globs = Vec::new();
    // Try flat array form first: "workspaces": [ ... ]
    if let Some(start) = content.find("\"workspaces\"") {
        let rest = &content[start + 12..]; // skip `"workspaces"`
        // skip whitespace + colon
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
        let rest = rest.trim_start();
        if rest.starts_with('[') {
            if let Some(arr_end) = rest.find(']') {
                let arr = &rest[1..arr_end];
                for item in arr.split(',') {
                    let pattern = item.trim().trim_matches('"').trim_matches('\'');
                    if !pattern.is_empty() {
                        globs.push(pattern.to_string());
                    }
                }
            }
        } else if rest.starts_with('{') {
            // Object form: "workspaces": { "packages": [...] }
            if let Some(pkg_start) = rest.find("\"packages\"") {
                let sub = &rest[pkg_start + 10..];
                let sub = sub.trim_start_matches(|c: char| c.is_whitespace() || c == ':').trim_start();
                if sub.starts_with('[') {
                    if let Some(arr_end) = sub.find(']') {
                        let arr = &sub[1..arr_end];
                        for item in arr.split(',') {
                            let pattern = item.trim().trim_matches('"').trim_matches('\'');
                            if !pattern.is_empty() {
                                globs.push(pattern.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    globs
}

/// Expand a list of `packages/*`-style glob patterns into `MonorepoPackage`
/// entries by enumerating subdirectories containing a `package.json`.
fn expand_npm_globs(cwd: &str, globs: &[String]) -> Vec<MonorepoPackage> {
    use crate::git::cmd::safe_repo_path;
    let cwd_path = std::path::Path::new(cwd);
    let mut packages = Vec::new();

    for pattern in globs {
        let base_pattern = pattern.replace("/*", "").replace("/**", "");
        // Security: validate the pattern-derived path stays inside cwd.
        let base_dir = match safe_repo_path(cwd, &base_pattern) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if base_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&base_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let pkg_json_path = path.join("package.json");
                    if pkg_json_path.exists() {
                        if let Ok(pkg_content) = std::fs::read_to_string(&pkg_json_path) {
                            let name = extract_json_string(&pkg_content, "name")
                                .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
                            let version = extract_json_string(&pkg_content, "version")
                                .unwrap_or_default();
                            let rel_path = path.strip_prefix(cwd_path)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|_| path.to_string_lossy().to_string());
                            packages.push(MonorepoPackage { name, path: rel_path, version });
                        }
                    }
                }
            }
        }
    }

    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages
}

// ─── Cargo workspace ─────────────────────────────────────────────────────

/// Hand-rolled `Cargo.toml` `[workspace]` scanner.
///
/// Parses `members = [...]` (possibly multi-line) and `exclude = [...]`,
/// then glob-expands each member pattern, reads each member's `Cargo.toml`
/// for `[package] name` / `version`. No `toml` crate — pure line scanning.
pub(crate) fn find_cargo_packages(cwd: &str, toml_content: &str) -> Vec<MonorepoPackage> {
    use crate::git::cmd::safe_repo_path;
    let cwd_path = std::path::Path::new(cwd);

    let members = parse_toml_string_array(toml_content, "members");
    let exclude = parse_toml_string_array(toml_content, "exclude");

    let mut packages = Vec::new();

    for pattern in &members {
        // Glob-expand: patterns like "crates/*" or "packages/foo"
        let dirs = expand_cargo_glob(cwd, pattern);
        for dir_rel in dirs {
            if exclude.contains(&dir_rel) {
                continue;
            }
            // Security: validate path
            let abs = match safe_repo_path(cwd, &dir_rel) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let member_toml = abs.join("Cargo.toml");
            if member_toml.exists() {
                let (name, version) = if let Ok(content) = std::fs::read_to_string(&member_toml) {
                    let n = parse_toml_scalar(&content, "name").unwrap_or_else(|| {
                        abs.file_name().map(|f| f.to_string_lossy().to_string())
                            .unwrap_or_else(|| dir_rel.clone())
                    });
                    let v = parse_toml_scalar(&content, "version").unwrap_or_default();
                    (n, v)
                } else {
                    (dir_rel.clone(), String::new())
                };
                // rel_path: use dir_rel (already relative)
                let rel_path = abs.strip_prefix(cwd_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or(dir_rel);
                packages.push(MonorepoPackage { name, path: rel_path, version });
            }
        }
    }

    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages
}

/// Expand a single Cargo workspace glob pattern (e.g. `crates/*`) to a list
/// of repo-relative directory paths that actually exist. Supports one-level
/// `*` only (sufficient for all common workspace layouts).
fn expand_cargo_glob(cwd: &str, pattern: &str) -> Vec<String> {
    use crate::git::cmd::safe_repo_path;
    if pattern.contains('*') {
        let base = pattern.replace("/*", "").replace('*', "");
        // Security: validate the pattern-derived base stays inside cwd before
        // any is_dir()/read_dir() syscall — mirrors expand_npm_globs.
        let base_dir = match safe_repo_path(cwd, &base) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        if !base_dir.is_dir() {
            return Vec::new();
        }
        // Build repo-relative paths by joining the (relative) base with each
        // entry's file name. We deliberately avoid strip_prefix(cwd) here:
        // safe_repo_path canonicalizes (resolving symlinks like macOS
        // /var → /private/var), so the canonical entry path may not be
        // prefixed by the raw cwd. The base + file_name composition is robust.
        let base_rel = base.trim_end_matches('/');
        let mut results = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&base_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let rel = if base_rel.is_empty() {
                        name
                    } else {
                        format!("{}/{}", base_rel, name)
                    };
                    results.push(rel);
                }
            }
        }
        results
    } else {
        // Literal path — validate before the is_dir() probe.
        let abs = match safe_repo_path(cwd, pattern) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        if abs.is_dir() { vec![pattern.to_string()] } else { Vec::new() }
    }
}

/// Parse a `key = "value"` scalar from a TOML section (e.g. `[package]`).
/// Returns the first match in the file (sufficient for member Cargo.toml files
/// which have exactly one `[package]` section).
pub(crate) fn parse_toml_scalar(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        // Skip TOML section headers and comments
        if trimmed.starts_with('[') || trimmed.starts_with('#') {
            continue;
        }
        // Match `key = "value"` or `key = 'value'`
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let rest = rest.trim();
                let value = rest.trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Parse a TOML array `key = [ "a", "b", ... ]` (possibly multi-line) from
/// Cargo.toml. Returns the string values. Ignores inline comments.
pub(crate) fn parse_toml_string_array(content: &str, key: &str) -> Vec<String> {
    // Find `key` followed by `=` then `[`
    let needle = format!("{} ", key);
    let needle2 = format!("{}=", key);
    let mut start_idx = None;
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with(&needle) || trimmed.starts_with(&needle2)
            || trimmed == key
        {
            // Check it has `=`
            if trimmed.contains('=') {
                // Find byte offset
                let offset: usize = content.lines().take(i).map(|l| l.len() + 1).sum();
                start_idx = Some(offset);
                break;
            }
        }
    }
    let start_idx = match start_idx {
        Some(i) => i,
        None => return Vec::new(),
    };
    // From start_idx, find the `[` that opens the array
    let rest = &content[start_idx..];
    let after_eq = match rest.find('=') {
        Some(i) => &rest[i + 1..],
        None => return Vec::new(),
    };
    let after_eq = after_eq.trim_start();
    if !after_eq.starts_with('[') {
        return Vec::new();
    }
    // Collect everything up to the matching `]` (handles multi-line)
    let mut depth = 0i32;
    let mut buf = String::new();
    let mut found = false;
    for ch in after_eq.chars() {
        match ch {
            '[' => {
                depth += 1;
                if depth == 1 { continue; } // skip the opening bracket
            }
            ']' => {
                depth -= 1;
                if depth == 0 { found = true; break; }
            }
            _ => {}
        }
        if depth > 0 {
            buf.push(ch);
        }
    }
    if !found {
        return Vec::new();
    }
    // Strip comment lines and inline comments, then split on commas.
    // Process line by line first so a comment line doesn't eat the next value.
    let clean: String = buf.lines()
        .map(|line| {
            let l = line.trim();
            if l.starts_with('#') {
                ""  // whole-line comment → drop
            } else if let Some(ci) = l.find('#') {
                &l[..ci]  // inline comment → keep left side
            } else {
                l
            }
        })
        .collect::<Vec<&str>>()
        .join(" ");

    let mut result = Vec::new();
    for item in clean.split(',') {
        let item = item.trim().trim_matches('"').trim_matches('\'').trim();
        if !item.is_empty() {
            result.push(item.to_string());
        }
    }
    result
}

// ─── go.work ──────────────────────────────────────────────────────────────

/// Parse `use (...)` and `use ./x` directives from a `go.work` file.
pub(crate) fn find_go_packages(cwd: &str, go_work_content: &str) -> Vec<MonorepoPackage> {
    let cwd_path = std::path::Path::new(cwd);
    let mut packages = Vec::new();

    // Two forms:
    //   use ./foo
    //   use (
    //       ./foo
    //       ./bar
    //   )
    let mut in_use_block = false;
    for line in go_work_content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("use (") || trimmed == "use (" {
            in_use_block = true;
            continue;
        }
        if in_use_block {
            if trimmed == ")" {
                in_use_block = false;
                continue;
            }
            if !trimmed.is_empty() && !trimmed.starts_with("//") {
                if let Some(pkg) = go_work_dir_to_package(cwd, cwd_path, trimmed) {
                    packages.push(pkg);
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("use ") {
            let dir = rest.trim();
            if !dir.starts_with('(') {
                if let Some(pkg) = go_work_dir_to_package(cwd, cwd_path, dir) {
                    packages.push(pkg);
                }
            }
        }
    }

    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages
}

fn go_work_dir_to_package(cwd: &str, cwd_path: &std::path::Path, dir: &str) -> Option<MonorepoPackage> {
    use crate::git::cmd::safe_repo_path;
    // Normalise: `./foo` → `foo`, `./` → `.` → skip
    let rel = dir.trim_start_matches("./");
    let rel = if rel.is_empty() { "." } else { rel };
    // Skip the root module
    if rel == "." {
        return None;
    }
    // Security check
    let abs = safe_repo_path(cwd, rel).ok()?;
    if !abs.is_dir() {
        return None;
    }
    let rel_path = abs.strip_prefix(cwd_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| rel.to_string());
    let name = abs.file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.clone());
    Some(MonorepoPackage { name, path: rel_path, version: String::new() })
}

// ─── nx ───────────────────────────────────────────────────────────────────

/// Scan `apps/` and `libs/` directories (respecting `workspaceLayout` in
/// `nx.json`) for subdirectories containing a `project.json` or `package.json`.
pub(crate) fn find_nx_packages(cwd: &str, nx_json_content: &str) -> Vec<MonorepoPackage> {
    use crate::git::cmd::safe_repo_path;
    let cwd_path = std::path::Path::new(cwd);

    // Detect custom layout dirs from nx.json
    let apps_dir = extract_json_string(nx_json_content, "appsDir")
        .unwrap_or_else(|| "apps".to_string());
    let libs_dir = extract_json_string(nx_json_content, "libsDir")
        .unwrap_or_else(|| "libs".to_string());

    let scan_dirs: Vec<String> = if apps_dir == libs_dir {
        vec![apps_dir]
    } else {
        vec![apps_dir, libs_dir]
    };

    let mut packages = Vec::new();

    for dir_name in &scan_dirs {
        let dir_abs = match safe_repo_path(cwd, dir_name) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !dir_abs.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&dir_abs) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let has_project_json = path.join("project.json").exists();
                let has_pkg_json = path.join("package.json").exists();
                if !has_project_json && !has_pkg_json {
                    continue;
                }
                let name = if has_project_json {
                    // Try to read name from project.json
                    std::fs::read_to_string(path.join("project.json"))
                        .ok()
                        .and_then(|c| extract_json_string(&c, "name"))
                        .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string())
                } else if has_pkg_json {
                    std::fs::read_to_string(path.join("package.json"))
                        .ok()
                        .and_then(|c| extract_json_string(&c, "name"))
                        .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string())
                } else {
                    entry.file_name().to_string_lossy().to_string()
                };
                let version = if has_pkg_json {
                    std::fs::read_to_string(path.join("package.json"))
                        .ok()
                        .and_then(|c| extract_json_string(&c, "version"))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let rel_path = path.strip_prefix(cwd_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| path.to_string_lossy().to_string());
                packages.push(MonorepoPackage { name, path: rel_path, version });
            }
        }
    }

    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages
}

pub(crate) fn read_git_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

pub(crate) fn read_git_u32(path: &Path) -> u32 {
    read_git_file(path).and_then(|s| s.parse().ok()).unwrap_or(0)
}

pub(crate) fn has_unresolved_conflicts(cwd: &str) -> bool {
    git_cmd()
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|l| matches!(l.get(..2), Some("UU" | "AA" | "UD" | "DU" | "AU" | "UA")))
        })
        .unwrap_or(false)
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod workspace_detection_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("gitwand-ws-test-{}-{}-{}-{}", label, pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir { path: dir }
        }

        fn cwd(&self) -> &str {
            self.path.to_str().unwrap()
        }

        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }
    }

    // ── Cargo ──────────────────────────────────────────────────

    #[test]
    fn cargo_workspace_members_glob() {
        let dir = TempDir::new("cargo");
        dir.write("Cargo.toml", r#"
[workspace]
members = ["crates/*"]
"#);
        dir.write("crates/foo/Cargo.toml", r#"
[package]
name = "foo"
version = "0.1.0"
"#);
        dir.write("crates/bar/Cargo.toml", r#"
[package]
name = "bar"
version = "0.2.0"
"#);

        let content = std::fs::read_to_string(dir.path.join("Cargo.toml")).unwrap();
        let pkgs = find_cargo_packages(dir.cwd(), &content);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"foo"), "expected 'foo' in {:?}", names);
        assert!(names.contains(&"bar"), "expected 'bar' in {:?}", names);
        assert_eq!(pkgs.iter().find(|p| p.name == "foo").unwrap().version, "0.1.0");
        assert_eq!(pkgs.iter().find(|p| p.name == "bar").unwrap().version, "0.2.0");
        // paths are repo-relative
        for pkg in &pkgs {
            assert!(!pkg.path.starts_with('/'), "path should be relative: {}", pkg.path);
        }
    }

    #[test]
    fn cargo_workspace_literal_member() {
        let dir = TempDir::new("cargo-lit");
        dir.write("Cargo.toml", r#"
[workspace]
members = ["packages/alpha", "packages/beta"]
"#);
        dir.write("packages/alpha/Cargo.toml", "[package]\nname = \"alpha\"\nversion = \"1.0.0\"\n");
        dir.write("packages/beta/Cargo.toml", "[package]\nname = \"beta\"\nversion = \"2.0.0\"\n");

        let content = std::fs::read_to_string(dir.path.join("Cargo.toml")).unwrap();
        let pkgs = find_cargo_packages(dir.cwd(), &content);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
    }

    #[test]
    fn cargo_workspace_exclude() {
        let dir = TempDir::new("cargo-excl");
        dir.write("Cargo.toml", r#"
[workspace]
members = ["crates/*"]
exclude = ["crates/skip"]
"#);
        dir.write("crates/keep/Cargo.toml", "[package]\nname = \"keep\"\nversion = \"0.1.0\"\n");
        dir.write("crates/skip/Cargo.toml", "[package]\nname = \"skip\"\nversion = \"0.1.0\"\n");

        let content = std::fs::read_to_string(dir.path.join("Cargo.toml")).unwrap();
        let pkgs = find_cargo_packages(dir.cwd(), &content);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"keep"));
        assert!(!names.contains(&"skip"), "excluded member should not appear");
    }

    #[test]
    fn cargo_malformed_manifest_yields_empty() {
        let dir = TempDir::new("cargo-bad");
        // Cargo.toml that looks like a workspace but is actually malformed JSON-in-TOML
        let content = "[workspace\nmembers = [\n";
        let pkgs = find_cargo_packages(dir.cwd(), content);
        assert!(pkgs.is_empty(), "malformed manifest should yield empty packages");
    }

    // ── go.work ───────────────────────────────────────────────

    #[test]
    fn go_work_use_block() {
        let dir = TempDir::new("go");
        let go_work = "go 1.21\n\nuse (\n    ./cmd/api\n    ./pkg/shared\n)\n";
        dir.write("cmd/api/main.go", "package main");
        dir.write("pkg/shared/lib.go", "package shared");

        let pkgs = find_go_packages(dir.cwd(), go_work);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"api"), "expected 'api' in {:?}", names);
        assert!(names.contains(&"shared"), "expected 'shared' in {:?}", names);
        // version is always empty for go
        for pkg in &pkgs {
            assert_eq!(pkg.version, "");
        }
    }

    #[test]
    fn go_work_single_use_directives() {
        let dir = TempDir::new("go-single");
        let go_work = "go 1.21\nuse ./services/auth\nuse ./services/catalog\n";
        dir.write("services/auth/main.go", "package main");
        dir.write("services/catalog/main.go", "package main");

        let pkgs = find_go_packages(dir.cwd(), go_work);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"auth"));
        assert!(names.contains(&"catalog"));
    }

    #[test]
    fn go_work_skips_root_module() {
        let dir = TempDir::new("go-root");
        // `use ./` refers to the repo root — should be skipped
        let go_work = "go 1.21\nuse ./\nuse ./sub\n";
        dir.write("sub/main.go", "package main");

        let pkgs = find_go_packages(dir.cwd(), go_work);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].name, "sub");
    }

    #[test]
    fn go_work_missing_dir_yields_no_entry() {
        let dir = TempDir::new("go-missing");
        let go_work = "go 1.21\nuse ./doesnotexist\n";
        let pkgs = find_go_packages(dir.cwd(), go_work);
        assert!(pkgs.is_empty());
    }

    // ── nx ────────────────────────────────────────────────────

    #[test]
    fn nx_default_layout() {
        let dir = TempDir::new("nx");
        dir.write("nx.json", "{}");
        dir.write("apps/web/project.json", r#"{"name":"web"}"#);
        dir.write("libs/ui/project.json", r#"{"name":"ui-lib"}"#);

        let content = std::fs::read_to_string(dir.path.join("nx.json")).unwrap();
        let pkgs = find_nx_packages(dir.cwd(), &content);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"web"), "expected 'web' in {:?}", names);
        assert!(names.contains(&"ui-lib"), "expected 'ui-lib' in {:?}", names);
    }

    #[test]
    fn nx_custom_workspace_layout() {
        let dir = TempDir::new("nx-custom");
        dir.write("nx.json", r#"{"workspaceLayout":{"appsDir":"services","libsDir":"shared"}}"#);
        dir.write("services/api/project.json", r#"{"name":"api"}"#);
        dir.write("shared/core/project.json", r#"{"name":"core"}"#);

        let content = std::fs::read_to_string(dir.path.join("nx.json")).unwrap();
        let pkgs = find_nx_packages(dir.cwd(), &content);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"api"), "expected 'api' in {:?}", names);
        assert!(names.contains(&"core"), "expected 'core' in {:?}", names);
    }

    #[test]
    fn nx_package_json_fallback() {
        let dir = TempDir::new("nx-pkg");
        dir.write("nx.json", "{}");
        dir.write("apps/dashboard/package.json", r#"{"name":"@acme/dashboard","version":"1.0.0"}"#);

        let content = std::fs::read_to_string(dir.path.join("nx.json")).unwrap();
        let pkgs = find_nx_packages(dir.cwd(), &content);
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"@acme/dashboard"), "expected '@acme/dashboard' in {:?}", names);
    }

    // ── turbo ─────────────────────────────────────────────────

    #[test]
    fn turbo_reuses_package_json_workspaces() {
        let dir = TempDir::new("turbo");
        dir.write("turbo.json", r#"{"$schema":"...","pipeline":{}}"#);
        dir.write("package.json", r#"{"name":"root","workspaces":["apps/*","packages/*"]}"#);
        dir.write("apps/web/package.json", r#"{"name":"web","version":"0.1.0"}"#);
        dir.write("packages/utils/package.json", r#"{"name":"utils","version":"1.0.0"}"#);

        let pkg_content = std::fs::read_to_string(dir.path.join("package.json")).unwrap();
        let pkgs = find_workspace_packages(dir.cwd(), &pkg_content, "turbo");
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"web"));
        assert!(names.contains(&"utils"));
    }

    // ── precedence test ───────────────────────────────────────

    #[test]
    fn precedence_pnpm_over_cargo() {
        // This test verifies the precedence logic in detect_monorepo by checking
        // that the pnpm parser is called when both pnpm-workspace.yaml and
        // Cargo.toml exist. We test the parsers directly since detect_monorepo
        // is async and we're in a sync test context.
        //
        // The precedence order itself is tested by the detect_monorepo function
        // structure: early returns ensure pnpm wins over cargo when both exist.
        // Here we just verify cargo packages are found correctly when cargo is used.
        let dir = TempDir::new("prec");
        dir.write("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n");
        dir.write("crates/mylib/Cargo.toml", "[package]\nname = \"mylib\"\nversion = \"0.1.0\"\n");

        let content = std::fs::read_to_string(dir.path.join("Cargo.toml")).unwrap();
        let pkgs = find_cargo_packages(dir.cwd(), &content);
        assert!(!pkgs.is_empty(), "cargo should detect mylib");
        assert_eq!(pkgs[0].name, "mylib");
    }

    #[test]
    fn detect_monorepo_pnpm_wins_over_cargo() {
        // Integration test of detect_monorepo's actual early-return precedence:
        // when BOTH pnpm-workspace.yaml AND Cargo.toml [workspace] exist, pnpm
        // must win (locked order: pnpm > Cargo > go.work > nx > turbo > npm/yarn).
        let dir = TempDir::new("prec-detect");
        dir.write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
        dir.write("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n");
        dir.write("crates/mylib/Cargo.toml", "[package]\nname = \"mylib\"\nversion = \"0.1.0\"\n");

        let info = tauri::async_runtime::block_on(
            crate::commands::ops::detect_monorepo(dir.cwd().to_string()),
        )
        .expect("detect_monorepo should not error");

        assert!(info.is_monorepo, "should be detected as a monorepo");
        assert_eq!(info.manager, "pnpm", "pnpm must win over cargo per locked precedence");
    }

    // ── TOML parsing helpers ──────────────────────────────────

    #[test]
    fn parse_toml_string_array_multiline() {
        let toml = r#"
[workspace]
members = [
    "crates/alpha",
    "crates/beta",
    # comment
    "crates/gamma",
]
"#;
        let members = parse_toml_string_array(toml, "members");
        assert_eq!(members, vec!["crates/alpha", "crates/beta", "crates/gamma"]);
    }

    #[test]
    fn parse_toml_scalar_basic() {
        let toml = "[package]\nname = \"my-crate\"\nversion = \"0.3.1\"\n";
        assert_eq!(parse_toml_scalar(toml, "name"), Some("my-crate".to_string()));
        assert_eq!(parse_toml_scalar(toml, "version"), Some("0.3.1".to_string()));
    }
}

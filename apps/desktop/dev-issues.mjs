/**
 * dev-server helpers for issue creation (#301): the rules of
 * `commands/gh_issues.rs` (`targets_from`, `check_target`, `issue_payload`),
 * kept in their own module so they can be tested without the server.
 */

/** A repository JSON (`GET /repos/{nwo}`) → its issue target, or null. */
function issueTarget(v, isOrigin) {
  if (!v || typeof v.full_name !== "string") return null;
  const perms = v.permissions || {};
  const canTriage = ["triage", "push", "maintain", "admin"].some((k) => perms[k] === true);
  return { repo: v.full_name, htmlUrl: v.html_url || "", hasIssues: v.has_issues === true, isOrigin, canTriage };
}

/** `targets_from`: origin, then its parent (carried in origin's JSON) when it is a fork. */
export function devIssueTargetsFrom(origin) {
  const targets = [issueTarget(origin, true)].filter(Boolean);
  if (origin?.fork === true) {
    const p = issueTarget(origin.parent, false);
    if (p) targets.push(p);
  }
  return { targets, defaultRepo: targets.find((t) => t.hasIssues)?.repo ?? null };
}

/** `check_target` with issues required: the error text, or null when allowed. */
export function devCheckIssueTarget(targets, repo) {
  const t = targets.targets.find((x) => x.repo === repo);
  if (!t) return `Not an issue target for this repository: ${repo}`;
  if (!t.hasIssues) return `Issues are disabled on ${repo}`;
  return null;
}

/** `issue_payload`: the title trimmed and required, the body verbatim, empty optionals left out. */
export function devIssuePayload(input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) return { error: "Title is required" };
  const p = { title, body: typeof input.body === "string" ? input.body : "" };
  if (Array.isArray(input.labels) && input.labels.length) p.labels = input.labels;
  if (Array.isArray(input.assignees) && input.assignees.length) p.assignees = input.assignees;
  if (Number.isInteger(input.milestone)) p.milestone = input.milestone;
  return { payload: p };
}

/**
 * GitHub `/assignees` items → `{login, name, avatar_url}`, deduplicated and
 * sorted by login (case-insensitive, byte order like the Rust
 * `assignees_from`). Shared by the reviewer-candidate and assignee routes.
 */
export function devAssigneesFrom(items) {
  const seen = new Set();
  const out = [];
  for (const u of items) {
    if (!u?.login || seen.has(u.login)) continue;
    seen.add(u.login);
    out.push({ login: u.login, name: u.name || null, avatar_url: u.avatar_url || null });
  }
  return out.sort((a, b) => {
    const x = a.login.toLowerCase(), y = b.login.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

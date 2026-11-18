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
  // An archived repository is read-only: it takes no new issue.
  const hasIssues = v.has_issues === true && v.archived !== true;
  return { repo: v.full_name, htmlUrl: v.html_url || "", hasIssues, isOrigin, canTriage };
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

/**
 * `check_target` with issues required: `{ repo }` (GitHub's spelling, which
 * the request then uses) or `{ error }`. One lookup for both, case-insensitive
 * like the Rust check.
 */
export function devResolveIssueTarget(targets, repo) {
  const t = targets.targets.find((x) => typeof repo === "string" && x.repo.toLowerCase() === repo.toLowerCase());
  if (!t) return { error: `Not an issue target for this repository: ${repo}` };
  if (!t.hasIssues) return { error: `Issues are disabled on ${repo}` };
  return { repo: t.repo };
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
 * A resolver report for GitWand's repository (#301), as Rust's
 * `gh_create_gitwand_issue` builds it: a title and a body only. Goes to
 * `env.GITWAND_DEV_REPORT_REPO` when set, so QA under dev:web can file on a
 * test fork instead of the real repository.
 */
export function devGitwandReport(input, env) {
  const built = devIssuePayload({ title: input?.title, body: input?.body });
  if (built.error) return built;
  return { repo: env?.GITWAND_DEV_REPORT_REPO || "devlint/GitWand", payload: built.payload };
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

/**
 * GitHub's error answer as the Rust `map_api_error` words it: the `message`,
 * plus a 422's `errors[]` details (which field was refused), so `dev:web`
 * shows the error text that ships.
 */
export function devGithubError(status, json) {
  const msg = typeof json?.message === "string" && json.message ? json.message : `HTTP ${status}`;
  const details = (Array.isArray(json?.errors) ? json.errors : [])
    .map((e) => {
      const s = (k) => (typeof e?.[k] === "string" && e[k] ? e[k] : null);
      if (s("message")) return s("message");
      if (s("field") && s("code")) return `${s("field")}: ${s("code")}`;
      return s("code");
    })
    .filter(Boolean);
  return details.length
    ? `GitHub API error (${status}): ${msg} (${details.join("; ")})`
    : `GitHub API error (${status}): ${msg}`;
}

const nonEmpty = (v) => (typeof v === "string" && v ? v : null);

/** `labels_from`: name required, empty description → null. */
export function devLabelsFrom(items) {
  return items
    .filter((l) => nonEmpty(l?.name))
    .map((l) => ({ name: l.name, color: nonEmpty(l.color) ?? "", description: nonEmpty(l.description) }));
}

/** `milestones_from`: number and title required, `due_on` → `dueOn`. */
export function devMilestonesFrom(items) {
  return items
    .filter((m) => Number.isInteger(m?.number) && nonEmpty(m.title))
    .map((m) => ({ number: m.number, title: m.title, dueOn: nonEmpty(m.due_on) }));
}

/** Prefixed (as `MAY_HAVE_BEEN_CREATED` in Rust) when GitHub may have filed the issue. */
export const MAY_HAVE_BEEN_CREATED = "[may-have-been-created] ";

/**
 * The create route's error for a failed POST answer, as `create_issue_inner`
 * words it: a 5xx after sending may have created the issue (marked), a 4xx is
 * GitHub's refusal.
 */
export function devCreateFailure(status, json) {
  const msg = devGithubError(status, json);
  return status >= 500 ? MAY_HAVE_BEEN_CREATED + msg : msg;
}

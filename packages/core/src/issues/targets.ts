/**
 * #301 — Where a repository's issues can go: `origin`, then its parent when
 * `origin` is a fork. Pure (a GitHub `GET /repos/{o}/{r}` answer in, targets
 * out), shared by the desktop's dev-server and the MCP `gitwand_create_issue`
 * tool. Mirror of Rust's `targets_from` (`commands/gh_issues.rs`).
 */

export interface IssueTarget {
  /** `owner/repo`, as GitHub spells it. */
  repo: string;
  htmlUrl: string;
  /** Issues enabled and the repository not archived (an archived one is read-only). */
  hasIssues: boolean;
  isOrigin: boolean;
  /** The viewer may set labels, assignees and milestones: triage, push, maintain or admin. */
  canTriage: boolean;
}

export interface IssueTargets {
  targets: IssueTarget[];
  /** The first target with issues, or null. */
  defaultRepo: string | null;
}

function target(v: unknown, isOrigin: boolean): IssueTarget | null {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  if (typeof j.full_name !== "string" || !j.full_name) return null;
  const perms = (j.permissions && typeof j.permissions === "object" ? j.permissions : {}) as Record<string, unknown>;
  return {
    repo: j.full_name,
    htmlUrl: typeof j.html_url === "string" ? j.html_url : "",
    hasIssues: j.has_issues === true && j.archived !== true,
    isOrigin,
    canTriage: ["triage", "push", "maintain", "admin"].some((k) => perms[k] === true),
  };
}

/**
 * `origin` (a repository JSON) → its targets. For a fork, `parent` is the
 * parent read on its own (the copy embedded in a fork's answer may lack the
 * viewer's `permissions`); without a usable one, the embedded copy.
 */
export function issueTargetsFrom(origin: unknown, parent?: unknown): IssueTargets {
  const o = target(origin, true);
  if (!o) return { targets: [], defaultRepo: null };
  const targets = [o];
  const j = origin as Record<string, unknown>;
  if (j.fork === true) {
    const p = target(parent, false) ?? target(j.parent, false);
    if (p) targets.push(p);
  }
  return { targets, defaultRepo: targets.find((t) => t.hasIssues)?.repo ?? null };
}

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

/** GitWand's own repository (Rust and TS `GITWAND_REPO`; a test keeps the three equal). */
export const GITWAND_REPO = "devlint/GitWand";

/**
 * A resolver report for GitWand's repository (#301), as Rust's
 * `gh_create_gitwand_issue` builds it: a title and a body only. Goes to
 * `env.GITWAND_DEV_REPORT_REPO` when set, so QA under dev:web can file on a
 * test fork instead of the real repository.
 */
export function devGitwandReport(input, env) {
  const built = devIssuePayload({ title: input?.title, body: input?.body });
  if (built.error) return built;
  return { repo: env?.GITWAND_DEV_REPORT_REPO || GITWAND_REPO, payload: built.payload };
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

// ─── Issue templates (#301, part 5) — mirrors gh_issue_templates ───────────
const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
/** Where an owner's `.github` repository may keep the default templates. */
const OWNER_TEMPLATE_DIRS = [TEMPLATE_DIR, "ISSUE_TEMPLATE", "docs/ISSUE_TEMPLATE"];
/** Folders of the single-template file (`ISSUE_TEMPLATE.md`, any case): `.github`, the root (""), `docs`. */
const SINGLE_TEMPLATE_DIRS = [".github", "", "docs"];
const MAX_TEMPLATES = 20;
const MAX_TEMPLATE_BYTES = 65_536;

function decodeContent(v) {
  if (typeof v?.content !== "string") return null;
  try {
    // Fatal: a file that is not UTF-8 is skipped, as Rust's from_utf8 does.
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(v.content.replace(/\s+/g, ""), "base64"));
  } catch {
    return null;
  }
}

/** Each segment percent-encoded as Rust's `encode_path` (unreserved kept). */
const encodePath = (path) =>
  path.split("/").map((seg) => [...Buffer.from(seg, "utf8")].map((b) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("")).join("/");
const smallEnough = (v) => typeof v?.size === "number" && v.size <= MAX_TEMPLATE_BYTES;
// By UTF-8 bytes, as Rust sorts strings (JS `<` compares UTF-16 units).
const cmp = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const isConfigPath = (path) => ["config.yml", "config.yaml"].includes((path.split("/").pop() ?? path).toLowerCase());

/**
 * `[file | null, complete, present]`, as Rust's `single_template`: the three
 * folders listed in parallel, the name matched in any case; an unreadable
 * file is still present (the repository's own).
 */
async function singleTemplate(nwo, get) {
  const listings = await Promise.all(SINGLE_TEMPLATE_DIRS.map((dir) => get(nwo, dir).then((v) => ({ v }), (e) => ({ e }))));
  let complete = listings.every((l) => !l.e);
  for (const { v } of listings) {
    if (!Array.isArray(v)) continue;
    const found = v.find((i) => i?.type === "file" && typeof i.name === "string" && i.name.toLowerCase() === "issue_template.md");
    if (!found || typeof found.path !== "string") continue;
    if (!smallEnough(found)) return [null, complete, true];
    try {
      const v = await get(nwo, encodePath(found.path));
      // Listed, then gone: a race, not an answer worth keeping.
      if (v === null) return [null, false, true];
      const content = decodeContent(v);
      return [content === null ? null : { path: found.path, content, single: true }, complete, true];
    } catch {
      complete = false;
      return [null, complete, true];
    }
  }
  return [null, complete, false];
}

/**
 * One repository's templates `{ files, complete, present }`, as Rust: any
 * file in its template folder (config.yml included) makes that folder the
 * whole answer; only without one is a single-template file looked for.
 */
async function templatesIn(nwo, dirs, get) {
  // Several folders (an owner's .github repository) are listed at once; the
  // first, in order, holding a template-like file is the answer.
  const listings = await Promise.all(dirs.map((dir) => get(nwo, dir).then((v) => ({ v }), (e) => ({ e }))));
  // In order, as Rust: a failure only counts before the folder that answers.
  for (const { v: items, e } of listings) {
    if (e) throw e;
    if (!Array.isArray(items)) continue;
    const listed = items.filter((i) => i?.type === "file" && typeof i.name === "string" && /\.(md|ya?ml)$/i.test(i.name));
    if (!listed.length) continue;
    // In name order: config.yml always, templates up to the cap.
    let templates = 0;
    const paths = listed
      .filter((i) => smallEnough(i) && typeof i.path === "string")
      .map((i) => [i.name, i.path])
      .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]))
      .filter(([, p]) => isConfigPath(p) || ++templates <= MAX_TEMPLATES)
      .map(([, p]) => p);
    const files = [];
    let complete = true;
    // Six at a time, as Rust; a file that cannot be read is skipped.
    for (let i = 0; i < paths.length; i += 6) {
      // A failed request (or a file gone since the listing) is retried next
      // time; a file read but not text is a lasting answer.
      const read = await Promise.all(paths.slice(i, i + 6).map(async (path) => {
        const v = await get(nwo, encodePath(path)).catch(() => null);
        if (v === null) return { failed: true };
        const content = decodeContent(v);
        return { file: content === null ? null : { path, content, single: false } };
      }));
      if (read.some((r) => r.failed)) complete = false;
      files.push(...read.map((r) => r.file).filter(Boolean));
    }
    return { files, complete, present: true };
  }
  const [single, complete, present] = await singleTemplate(nwo, get);
  return { files: single ? [single] : [], complete, present };
}

/**
 * A target's issue template files, as `gh_issue_templates` reads them: the
 * template directory, else a single-template file, else the same in the
 * owner's public `.github` repository. `get(nwo, path)` resolves `null` on a
 * 404; `isPublic(nwo)` whether a repository is public.
 */
export async function devTemplateFiles(nwo, isPublic, get) {
  const own = await templatesIn(nwo, [TEMPLATE_DIR], get);
  const mine = (complete) => ({ source: nwo, files: own.files, complete });
  // Only a repository with no template folder and no single template gets
  // its owner's; a failed listing leaves that unknown (no fallback, not cached).
  if (own.present || !own.complete) return mine(own.complete);
  const org = `${nwo.split("/")[0]}/.github`;
  if (org.toLowerCase() === nwo.toLowerCase()) return mine(own.complete);
  // Visibility and folders asked at once; the folders count only if public.
  const [pub, theirs] = await Promise.all([
    isPublic(org).then((v) => ({ v }), (e) => ({ e })),
    templatesIn(org, OWNER_TEMPLATE_DIRS, get).then((v) => ({ v }), (e) => ({ e })),
  ]);
  if (pub.e || theirs.e) return mine(false);
  if (pub.v && theirs.v.present) return { source: org, files: theirs.v.files, complete: theirs.v.complete };
  return mine(own.complete);
}

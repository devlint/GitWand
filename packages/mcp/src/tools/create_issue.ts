/**
 * #301 part 6 — Tool `gitwand_create_issue`: file a GitHub issue on the
 * repository the agent works in, as the desktop app does.
 *
 * - Target: `origin`, or its fork parent when `origin` takes no issues
 *   (disabled or archived) — the desktop's rule (`targets_from` in
 *   `commands/gh_issues.rs`, `devIssueTargetsFrom` in `dev-issues.mjs`).
 *   Read from `git remote get-url origin` and `gh api repos/{o}/{r}`, never
 *   from `gh repo view` alone, which may pick `upstream` (#298).
 * - Preview by default: nothing is created without `dry_run: false`.
 * - Title and body go through core's `scanReportBody` first; a known secret
 *   pattern refuses the issue.
 * - Through `gh` (its own login, or `GH_TOKEN`/`GITHUB_TOKEN`), spawned with
 *   array args and only the environment it needs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGitwandrc, scanReportBody, type ReportScan, type SecretFinding, type SecretPattern } from "@gitwand/core";

// ─── Remote URL ──────────────────────────────────────────────

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function ownerRepo(host: string, path: string): RemoteRepo | null {
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!host || !SEGMENT.test(owner) || !SEGMENT.test(repo) || repo === "." || repo === "..") return null;
  return { host: host.toLowerCase(), owner, repo };
}

/**
 * `{host, owner, repo}` of a remote URL — `https://host/o/r(.git)`,
 * `ssh://[user@]host[:port]/o/r(.git)`, `[user@]host:o/r(.git)` — or null for
 * a local path, a `file://` URL or a path that is not `owner/repo`.
 */
export function parseRemoteUrl(url: string): RemoteRepo | null {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    return ownerRepo(parsed.hostname, decodeURIComponent(parsed.pathname));
  }
  // scp-like: [user@]host:path — a host has no slash, the path does not start with one.
  const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  return m ? ownerRepo(m[1], m[2]) : null;
}

// ─── Targets ─────────────────────────────────────────────────

export interface IssueTarget {
  /** `owner/repo`, as GitHub spells it. */
  repo: string;
  /** Issues enabled and the repository not archived. */
  hasIssues: boolean;
  isOrigin: boolean;
}

function target(v: unknown, isOrigin: boolean): IssueTarget | null {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  if (typeof j.full_name !== "string" || !j.full_name) return null;
  return { repo: j.full_name, hasIssues: j.has_issues === true && j.archived !== true, isOrigin };
}

/** A `GET /repos/{o}/{r}` answer → origin, then its parent when it is a fork. */
export function targetsFrom(json: unknown): IssueTarget[] {
  const origin = target(json, true);
  if (!origin) return [];
  const out = [origin];
  const j = json as Record<string, unknown>;
  if (j.fork === true) {
    const parent = target(j.parent, false);
    if (parent) out.push(parent);
  }
  return out;
}

// ─── Running gh ──────────────────────────────────────────────

/** What `gh` may see of this process's environment (AGENTS.md: only what it needs). */
const GH_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "windir",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * The environment `gh` runs with: the allow-list above, plus no prompt, no
 * update notice, no colour. `GH_HOST`/`GH_REPO` never pass: the target is
 * always named on the command line.
 */
export function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of GH_ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  return env;
}

const GH_TIMEOUT_MS = 30_000;

export type GhResult = { ok: true; stdout: string } | { ok: false; missing: boolean; stderr: string };

/** `gh args…` in `cwd`, `input` on stdin; never throws. */
export function runGh(args: string[], cwd: string, input?: string): GhResult {
  try {
    const stdout = execFileSync("gh", args, {
      cwd,
      env: ghEnv(),
      input: input ?? "",
      encoding: "utf-8",
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer; signal?: string };
    if (e.code === "ENOENT") return { ok: false, missing: true, stderr: "" };
    if (e.signal === "SIGTERM") return { ok: false, missing: false, stderr: `gh did not answer within ${GH_TIMEOUT_MS / 1000} s` };
    const stderr = (typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf-8") ?? "").trim();
    return { ok: false, missing: false, stderr: stderr || e.message };
  }
}

// ─── The tool ────────────────────────────────────────────────

/** GitHub's limits: a title of 256 characters, a body of 65,536. */
const MAX_TITLE = 256;
const MAX_BODY = 65_536;
/** `.gitwandrc` `secrets.entropyThreshold` default (the desktop's and the CLI's). */
const DEFAULT_ENTROPY_THRESHOLD = 4.0;

export const createIssueToolDefinition = {
  name: "gitwand_create_issue",
  description:
    "File a GitHub issue on the repository in `cwd`, through the `gh` CLI (its login, or GH_TOKEN/GITHUB_TOKEN). " +
    "PREVIEWS BY DEFAULT: without `dry_run: false` nothing is created, and the tool returns the target repository, the title, " +
    "body, labels and assignees it would send, and what the secrets scan found. Show that preview to the user, and call again " +
    "with `dry_run: false` only once they agree. " +
    "Target: the `origin` remote's repository, or its fork parent when issues are disabled (or the repository archived) on " +
    "`origin`; an explicit `repo` must be one of those two. " +
    "Title and body are scanned for secrets first: a known secret pattern (high or medium severity) refuses the issue, even " +
    "with `dry_run: false`; a high-entropy string only warns. Labels must already exist on the target repository.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cwd: {
        type: "string",
        description: "Working directory (repo root). Defaults to server cwd.",
      },
      title: {
        type: "string",
        description: "Issue title (1-256 characters, trimmed).",
      },
      body: {
        type: "string",
        description: "Issue body, Markdown, sent verbatim (at most 65,536 characters).",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Label names; each must already exist on the target repository. No commas.",
      },
      assignees: {
        type: "array",
        items: { type: "string" },
        description: "GitHub logins to assign (`@me` for the signed-in user). No commas.",
      },
      repo: {
        type: "string",
        description: "`owner/repo` to file on: the origin repository or its fork parent. Defaults to origin, or the parent when origin takes no issues.",
      },
      dry_run: {
        type: "boolean",
        description: "Default: true — preview only. Pass false to create the issue, after the user has seen the preview.",
      },
    },
    required: ["title"],
  },
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error, message }, null, 2) }],
  isError: true,
});

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/** A list argument: absent → [], else non-empty strings without commas (gh splits on them). */
function list(v: unknown, name: string): string[] | ToolResult {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "" && !x.includes(","))) {
    return fail("invalid_list", `\`${name}\` must be a list of non-empty names without commas.`);
  }
  return v.map((x: string) => x.trim());
}

/** The repository's `.gitwandrc` secrets settings, as the scan takes them. */
function secretsOptions(root: string) {
  const opts = { extraPatterns: [] as SecretPattern[], ignore: [] as string[], entropyThreshold: DEFAULT_ENTROPY_THRESHOLD };
  for (const filename of [".gitwandrc", ".gitwandrc.json"]) {
    let content: string;
    try {
      content = readFileSync(join(root, filename), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseGitwandrc(content);
    if (parsed === null) continue;
    return {
      extraPatterns: parsed.secrets?.patterns ?? [],
      ignore: parsed.secrets?.ignore ?? [],
      entropyThreshold: parsed.secrets?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    };
  }
  return opts;
}

/**
 * Title and body scanned as one text, the title on line 0: body lines keep
 * their own numbers.
 */
function scanIssue(root: string, title: string, body: string): ReportScan {
  const scan = scanReportBody(body === "" ? title : `${title}\n${body}`, { ...secretsOptions(root), blockAt: "medium" });
  const shift = (f: SecretFinding) => ({ ...f, file: f.line === 1 ? "title" : "body", line: f.line - 1 });
  return { blocking: scan.blocking.map(shift), warnings: scan.warnings.map(shift) };
}

export async function handleCreateIssue(cwd: string, args: Record<string, unknown>): Promise<ToolResult> {
  // 1. Arguments — nothing runs on a malformed call.
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || title.length > MAX_TITLE) {
    return fail("invalid_title", `\`title\` is required and must be at most ${MAX_TITLE} characters.`);
  }
  if (args.body !== undefined && typeof args.body !== "string") return fail("invalid_body", "`body` must be a string.");
  const body = (args.body as string | undefined) ?? "";
  if (body.length > MAX_BODY) return fail("invalid_body", `\`body\` is ${body.length} characters; GitHub takes at most ${MAX_BODY}.`);
  const labels = list(args.labels, "labels");
  if (!Array.isArray(labels)) return labels;
  const assignees = list(args.assignees, "assignees");
  if (!Array.isArray(assignees)) return assignees;
  if (args.repo !== undefined && typeof args.repo !== "string") return fail("repo_not_allowed", "`repo` must be `owner/repo`.");
  if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") {
    return fail("invalid_dry_run", "`dry_run` must be a boolean (true previews, false creates).");
  }
  const dryRun = args.dry_run !== false;

  // 2. The origin remote.
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return fail("not_a_repo", `Not a Git repository: ${cwd}`);
  const url = git(root, ["remote", "get-url", "origin"]);
  if (!url) return fail("no_origin", "This repository has no `origin` remote to file an issue on.");
  const remote = parseRemoteUrl(url);
  if (!remote) return fail("unsupported_remote", "The `origin` remote is not a `host/owner/repo` URL.");

  // 3. Its issue targets, as GitHub describes them.
  const api = runGh(["api", "--hostname", remote.host, `repos/${remote.owner}/${remote.repo}`], root);
  if (!api.ok) {
    if (api.missing) return fail("gh_missing", "The GitHub CLI (`gh`) is not installed or not on PATH: https://cli.github.com");
    return fail("target_lookup_failed", `gh could not read ${remote.owner}/${remote.repo}: ${api.stderr}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(api.stdout);
  } catch {
    json = null;
  }
  const targets = targetsFrom(json);
  if (!targets.length) return fail("target_lookup_failed", `gh gave no repository for ${remote.owner}/${remote.repo}.`);

  let chosen: IssueTarget | undefined;
  if (typeof args.repo === "string") {
    const wanted = args.repo.trim().toLowerCase();
    chosen = targets.find((t) => t.repo.toLowerCase() === wanted);
    if (!chosen) {
      return fail("repo_not_allowed", `\`repo\` must be one of: ${targets.map((t) => t.repo).join(", ")}.`);
    }
    if (!chosen.hasIssues) return fail("issues_disabled", `${chosen.repo} takes no issues (disabled or archived).`);
  } else {
    chosen = targets.find((t) => t.hasIssues);
    if (!chosen) {
      return fail("no_issue_target", `No repository takes issues: ${targets.map((t) => t.repo).join(", ")} (disabled or archived).`);
    }
  }

  // 4. Secrets.
  const secrets = scanIssue(root, title, body);
  const canCreate = secrets.blocking.length === 0;

  if (dryRun) {
    return ok({
      dryRun: true,
      repo: chosen.repo,
      isOrigin: chosen.isOrigin,
      title,
      body,
      labels,
      assignees,
      secrets,
      canCreate,
      next: canCreate
        ? "Nothing was created. Show this preview to the user; call again with dry_run: false once they agree."
        : "Nothing was created, and this issue cannot be: remove the secrets listed in `secrets.blocking` first.",
    });
  }
  if (!canCreate) {
    return fail(
      "secrets_found",
      `Not created: ${secrets.blocking.map((f) => `${f.patternId} (${f.file}${f.file === "body" ? ` line ${f.line}` : ""})`).join(", ")}. Remove the secrets and try again.`,
    );
  }

  // 5. Create.
  const create = [
    "issue", "create",
    "--repo", `${remote.host}/${chosen.repo}`,
    "--title", title,
    "--body-file", "-",
    ...labels.flatMap((l) => ["--label", l]),
    ...assignees.flatMap((a) => ["--assignee", a]),
  ];
  const made = runGh(create, root, body);
  if (!made.ok) {
    if (made.missing) return fail("gh_missing", "The GitHub CLI (`gh`) is not installed or not on PATH: https://cli.github.com");
    return fail("create_failed", `gh could not create the issue on ${chosen.repo}: ${made.stderr}`);
  }
  // gh prints the new issue's URL last.
  const issueUrl = made.stdout.trim().split("\n").pop()?.trim() ?? "";
  const m = /\/issues\/(\d+)$/.exec(issueUrl);
  return ok({ created: true, repo: chosen.repo, number: m ? Number(m[1]) : null, url: m ? issueUrl : null });
}

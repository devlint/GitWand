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

import { spawn } from "node:child_process";
import { DEFAULT_ENTROPY_THRESHOLD, scanReportBody, type ReportScan, type SecretFinding } from "@gitwand/core";
import { gitTry, readGitwandrc } from "../repo-config.js";

// ─── Remote URL ──────────────────────────────────────────────

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
  /** Reached over SSH (`host` may then be an alias from ~/.ssh/config). */
  ssh: boolean;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function ownerRepo(host: string, path: string, ssh: boolean): RemoteRepo | null {
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!host || !SEGMENT.test(owner) || !SEGMENT.test(repo) || repo === "." || repo === "..") return null;
  return { host: host.toLowerCase(), owner, repo, ssh };
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
    let path: string;
    try {
      parsed = new URL(u);
      path = decodeURIComponent(parsed.pathname);
    } catch {
      // Not a URL, or a malformed %-escape in its path.
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    return ownerRepo(parsed.hostname, path, parsed.protocol === "ssh:");
  }
  // scp-like: [user@]host:path — a host has no slash, the path does not start with one.
  const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  return m ? ownerRepo(m[1], m[2], true) : null;
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
  // gh's keyring on Linux (Secret Service) is reached over the session bus.
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
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

/**
 * How long `gh` and `ssh -G` may take. A create gets longer than a read, as
 * in the desktop: a POST cut short may still have filed the issue. Mutable
 * for tests only.
 */
export const createIssueTimeouts = { readMs: 30_000, createMs: 60_000, sshMs: 5_000 };

export type GhResult =
  | { ok: true; stdout: string }
  /**
   * `missing`: gh is not installed. `interrupted`: gh did not finish (timed
   * out or stopped by a signal) — what it was doing may have happened.
   */
  | { ok: false; missing: boolean; interrupted: boolean; stderr: string };

const MAX_OUTPUT = 16 * 1024 * 1024;

interface Ran {
  /** The program could not be started (ENOENT: not installed). */
  missing: boolean;
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * `cmd args…` without blocking the server's event loop (the MCP server
 * answers other requests meanwhile): `input` on stdin, killed after
 * `timeoutMs`, output capped. Never rejects.
 */
function run(cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number }): Promise<Ran> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const done = (r: Omit<Ran, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, timedOut, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") });
    };
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill("SIGTERM");
      else into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) => done({ missing: e.code === "ENOENT", code: null, signal: null }));
    child.on("close", (code, signal) => done({ missing: false, code, signal }));
    // A child that exits before reading stdin must not crash the server.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** `gh args…` in `cwd`, `input` on stdin, killed after `timeoutMs`; never rejects. */
export async function runGh(args: string[], cwd: string, input: string | undefined, timeoutMs: number): Promise<GhResult> {
  const r = await run("gh", args, { cwd, env: ghEnv(), input, timeoutMs });
  if (r.missing) return { ok: false, missing: true, interrupted: false, stderr: "" };
  if (r.timedOut) return { ok: false, missing: false, interrupted: true, stderr: `gh did not answer within ${timeoutMs / 1000} s` };
  if (r.signal) return { ok: false, missing: false, interrupted: true, stderr: `gh was stopped by ${r.signal}` };
  if (r.code !== 0) return { ok: false, missing: false, interrupted: false, stderr: r.stderr.trim() || `gh exited with code ${r.code}` };
  return { ok: true, stdout: r.stdout };
}

/** What `ssh` may see: enough to find and read its config, no token. */
const SSH_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "windir", "TMPDIR", "TEMP", "TMP"];

/** Per host, for the server's life: ~/.ssh/config rarely changes under it. */
const sshHosts = new Map<string, string>();

/**
 * The host `ssh` connects to for `host` (`ssh -G` reads ~/.ssh/config
 * without connecting), so an alias such as `github-work` becomes the host gh
 * knows; `ssh.github.com` (SSH over 443) is github.com, as gh reads it. The
 * host itself when ssh is missing, fails or times out — the desktop's
 * `ssh_resolved_host`.
 */
export async function sshResolvedHost(host: string): Promise<string> {
  const known = sshHosts.get(host);
  if (known) return known;
  let resolved = host;
  // A plain host name only: never something ssh would read as an option.
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    const env: NodeJS.ProcessEnv = {};
    for (const k of SSH_ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
    const r = await run("ssh", ["-G", host], { env, timeoutMs: createIssueTimeouts.sshMs });
    if (!r.missing && !r.timedOut && r.code === 0) {
      const line = r.stdout.split("\n").find((l) => l.startsWith("hostname "));
      const name = line?.slice("hostname ".length).trim().toLowerCase();
      if (name) resolved = name;
      sshHosts.set(host, resolved === "ssh.github.com" ? "github.com" : resolved);
    }
  }
  return resolved === "ssh.github.com" ? "github.com" : resolved;
}

/** Hosts gh is signed in to (github.com needs no check: a token or sign-in is checked by the call itself). */
const signedInHosts = new Set<string>();

/**
 * Whether `host` is a GitHub `gh` can reach: github.com, or a host gh is
 * signed in to (GitHub Enterprise) — the desktop's rule. Any other host
 * (gitlab.com, bitbucket.org…) is not GitHub.
 */
async function isGithubHost(cwd: string, host: string): Promise<boolean | "gh_missing"> {
  if (host === "github.com" || signedInHosts.has(host)) return true;
  const r = await runGh(["auth", "status", "--hostname", host], cwd, undefined, createIssueTimeouts.readMs);
  if (!r.ok && r.missing) return "gh_missing";
  if (r.ok) signedInHosts.add(host);
  return r.ok;
}

/** A target read stays good this long: a preview then its create read it once. */
const TARGETS_TTL_MS = 60_000;
const targetsCache = new Map<string, { at: number; targets: IssueTarget[] }>();

/** Clears what the tool remembers between calls (tests). */
export function resetCreateIssueCaches(): void {
  sshHosts.clear();
  signedInHosts.clear();
  targetsCache.clear();
}

/**
 * gh's words after a failed create that may still have reached GitHub: a 5xx,
 * or the connection lost (EOF, reset, timeout) — the desktop's
 * `MAY_HAVE_BEEN_CREATED` cases. A refusal (4xx, unknown label or user)
 * means nothing was filed.
 */
const MAYBE_SENT = /HTTP 5\d\d|unexpected EOF|connection reset|broken pipe|i\/o timeout|timeout awaiting|TLS handshake|stream error|GOAWAY|http2:/i;

// ─── The tool ────────────────────────────────────────────────

/** GitHub's limits: a title of 256 characters, a body of 65,536 (code points, not UTF-16 units). */
const MAX_TITLE = 256;
const MAX_BODY = 65_536;

export const createIssueToolDefinition = {
  name: "gitwand_create_issue",
  description:
    "File a GitHub issue on the repository in `cwd`, through the `gh` CLI (its login, or GH_TOKEN/GITHUB_TOKEN). " +
    "PREVIEWS BY DEFAULT: without `dry_run: false` nothing is created, and the tool returns the target repository, the title, " +
    "labels and assignees it would send, the body's length (the body is sent exactly as given), and what the secrets scan " +
    "found. Show the user that preview with the body you passed, and call again with `dry_run: false` only once they agree. " +
    "If a create returns `create_uncertain`, the issue may exist: check before calling again. " +
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

/** A list argument: absent → [], else non-empty strings without commas (gh splits on them). */
function list(v: unknown, name: string): string[] | ToolResult {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "" && !x.includes(","))) {
    return fail("invalid_list", `\`${name}\` must be a list of non-empty names without commas.`);
  }
  return v.map((x: string) => x.trim());
}

/**
 * Title and body scanned each on its own, as the desktop form does: a finding
 * names the field (`title` / `body`) and that field's own line. Always on,
 * with the repository's `.gitwandrc` secrets settings.
 */
function scanIssue(root: string, title: string, body: string): ReportScan {
  const rc = readGitwandrc(root)?.secrets;
  const opts = {
    extraPatterns: rc?.patterns ?? [],
    ignore: rc?.ignore ?? [],
    entropyThreshold: rc?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    blockAt: "medium" as const,
  };
  const out: ReportScan = { blocking: [], warnings: [] };
  for (const [file, text] of [["title", title], ["body", body]] as const) {
    const r = scanReportBody(text, opts);
    const tag = (f: SecretFinding) => ({ ...f, file });
    out.blocking.push(...r.blocking.map(tag));
    out.warnings.push(...r.warnings.map(tag));
  }
  return out;
}

/** origin's issue targets, read once a minute at most; a failure is not remembered. */
async function readTargets(root: string, host: string, remote: RemoteRepo): Promise<IssueTarget[] | { error: ToolResult }> {
  const key = `${host}/${remote.owner}/${remote.repo}`.toLowerCase();
  const hit = targetsCache.get(key);
  if (hit && Date.now() - hit.at < TARGETS_TTL_MS) return hit.targets;
  const api = await runGh(["api", "--hostname", host, `repos/${remote.owner}/${remote.repo}`], root, undefined, createIssueTimeouts.readMs);
  if (!api.ok) {
    if (api.missing) return { error: ghMissing() };
    return { error: fail("target_lookup_failed", `gh could not read ${remote.owner}/${remote.repo}: ${api.stderr}`) };
  }
  let json: unknown;
  try {
    json = JSON.parse(api.stdout);
  } catch {
    json = null;
  }
  const targets = targetsFrom(json);
  if (!targets.length) return { error: fail("target_lookup_failed", `gh gave no repository for ${remote.owner}/${remote.repo}.`) };
  targetsCache.set(key, { at: Date.now(), targets });
  return targets;
}

const ghMissing = () => fail("gh_missing", "The GitHub CLI (`gh`) is not installed or not on PATH: https://cli.github.com");

/** Characters as GitHub counts them: code points (an emoji is one). */
const chars = (s: string) => [...s].length;

export async function handleCreateIssue(cwd: string, args: Record<string, unknown>): Promise<ToolResult> {
  // 1. Arguments — nothing runs on a malformed call.
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || chars(title) > MAX_TITLE || /[\r\n]/.test(title)) {
    return fail("invalid_title", `\`title\` is required: one line of at most ${MAX_TITLE} characters.`);
  }
  if (args.body !== undefined && typeof args.body !== "string") return fail("invalid_body", "`body` must be a string.");
  const body = (args.body as string | undefined) ?? "";
  const bodyChars = chars(body);
  if (bodyChars > MAX_BODY) return fail("invalid_body", `\`body\` is ${bodyChars} characters; GitHub takes at most ${MAX_BODY}.`);
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
  const root = gitTry(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return fail("not_a_repo", `Not a Git repository: ${cwd}`);
  const url = gitTry(root, ["remote", "get-url", "origin"]);
  if (!url) return fail("no_origin", "This repository has no `origin` remote to file an issue on.");
  const remote = parseRemoteUrl(url);
  if (!remote) return fail("unsupported_remote", "The `origin` remote is not a `host/owner/repo` URL.");
  const host = remote.ssh ? await sshResolvedHost(remote.host) : remote.host;
  const github = await isGithubHost(root, host);
  if (github === "gh_missing") return ghMissing();
  if (!github) {
    return fail(
      "not_github",
      `The \`origin\` remote is on ${host}, which is not github.com nor a GitHub Enterprise host gh is signed in to (\`gh auth login --hostname ${host}\` if it is one).`,
    );
  }

  // 3. Its issue targets, as GitHub describes them.
  const targets = await readTargets(root, host, remote);
  if ("error" in targets) return targets.error;

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
      // The body is the caller's own text, sent verbatim: its size, not a copy.
      bodyChars,
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
      `Not created: ${secrets.blocking.map((f) => `${f.patternId} (${f.file} line ${f.line})`).join(", ")}. Remove the secrets and try again.`,
    );
  }

  // 5. Create.
  const create = [
    "issue", "create",
    "--repo", `${host}/${chosen.repo}`,
    "--title", title,
    "--body-file", "-",
    ...labels.flatMap((l) => ["--label", l]),
    ...assignees.flatMap((a) => ["--assignee", a]),
  ];
  const made = await runGh(create, root, body, createIssueTimeouts.createMs);
  if (!made.ok) {
    if (made.missing) return ghMissing();
    if (made.interrupted || MAYBE_SENT.test(made.stderr)) {
      return fail(
        "create_uncertain",
        `${made.stderr}. The issue may have been created: check https://${host}/${chosen.repo}/issues before trying again.`,
      );
    }
    return fail("create_failed", `gh could not create the issue on ${chosen.repo}: ${made.stderr}`);
  }
  // gh prints the new issue's URL last.
  const issueUrl = made.stdout.trim().split("\n").pop()?.trim() ?? "";
  const m = /\/issues\/(\d+)$/.exec(issueUrl);
  return ok({ created: true, repo: chosen.repo, number: m ? Number(m[1]) : null, url: m ? issueUrl : null });
}

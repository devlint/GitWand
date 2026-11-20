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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DEFAULT_ENTROPY_THRESHOLD, scanReportBody, type ReportScan, type SecretFinding } from "@gitwand/core";
import { gitTryAsync, readGitwandrcAsync } from "../repo-config.js";
import { run } from "../spawn.js";

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
    if (parsed.search || parsed.hash) return null;
    const ssh = parsed.protocol === "ssh:";
    // Over https the port is the web/API server's (gh names such a host
    // `host:port`); over ssh it is only the ssh daemon's.
    return ownerRepo(ssh ? parsed.hostname : parsed.host, path, ssh);
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
  /** The viewer may set labels and assignees (triage, push, maintain or admin). */
  canTriage: boolean;
}

function target(v: unknown, isOrigin: boolean): IssueTarget | null {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  if (typeof j.full_name !== "string" || !j.full_name) return null;
  const perms = (j.permissions && typeof j.permissions === "object" ? j.permissions : {}) as Record<string, unknown>;
  return {
    repo: j.full_name,
    hasIssues: j.has_issues === true && j.archived !== true,
    isOrigin,
    canTriage: ["triage", "push", "maintain", "admin"].some((k) => perms[k] === true),
  };
}

/**
 * A `GET /repos/{o}/{r}` answer → origin, then its parent when it is a fork:
 * `parent` read on its own when given (the copy embedded in a fork's answer
 * may lack the viewer's rights), else the embedded one — as the desktop's
 * `targets_from`.
 */
export function targetsFrom(json: unknown, parent?: unknown): IssueTarget[] {
  const origin = target(json, true);
  if (!origin) return [];
  const out = [origin];
  const j = json as Record<string, unknown>;
  if (j.fork === true) {
    const p = target(parent, false) ?? target(j.parent, false);
    if (p) out.push(p);
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
 * The tool's limits. A create gets longer than a read, as in the desktop: a
 * POST cut short may still have filed the issue. Mutable for tests only.
 */
export const createIssueTimeouts = {
  readMs: 30_000,
  createMs: 60_000,
  sshMs: 5_000,
  /** SIGTERM → SIGKILL → giving up on a child that will not end. */
  killGraceMs: 2_000,
  maxOutputBytes: 16 * 1024 * 1024,
  /** The secrets scan when the repository adds its own patterns (they run in a worker). */
  scanMs: 5_000,
  /** A failed `ssh -G` is asked again after this; a successful one is kept. */
  sshFailureTtlMs: 60_000,
  /** A GitHub Enterprise sign-in is checked again after this. */
  signedInTtlMs: 5 * 60_000,
};

export type GhResult =
  | { ok: true; stdout: string }
  /**
   * `missing`: gh is not installed. `interrupted`: gh did not finish (timed
   * out, stopped by a signal, or stopped for flooding its output) — what it
   * was doing may have happened.
   */
  | { ok: false; missing: boolean; interrupted: boolean; stderr: string };

/** `gh args…` in `cwd`, `input` on stdin, stopped after `timeoutMs`; never rejects. */
export async function runGh(args: string[], cwd: string, input: string | undefined, timeoutMs: number): Promise<GhResult> {
  const r = await run("gh", args, {
    cwd,
    env: ghEnv(),
    input,
    timeoutMs,
    killGraceMs: createIssueTimeouts.killGraceMs,
    maxOutputBytes: createIssueTimeouts.maxOutputBytes,
  });
  const stopped = (why: string) => ({ ok: false as const, missing: false, interrupted: true, stderr: why });
  if (r.missing) return { ok: false, missing: true, interrupted: false, stderr: "" };
  if (r.timedOut) return stopped(`gh did not answer within ${timeoutMs / 1000} s`);
  if (r.capped) return stopped(`gh wrote more than ${createIssueTimeouts.maxOutputBytes} bytes and was stopped`);
  if (r.signal) return stopped(`gh was stopped by ${r.signal}`);
  if (r.code !== 0) {
    return { ok: false, missing: false, interrupted: false, stderr: r.stderr.trim() || `gh exited with code ${r.code ?? "?"}` };
  }
  return { ok: true, stdout: r.stdout };
}

/** What `ssh` may see: enough to find and read its config, no token. */
const SSH_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "windir", "TMPDIR", "TEMP", "TMP"];

/** Per host: a resolved name for the server's life, a failed lookup for `sshFailureTtlMs`. */
const sshHosts = new Map<string, { host: string; ok: boolean; at: number }>();

/**
 * The host `ssh` connects to for `host` (`ssh -G` reads ~/.ssh/config
 * without connecting), so an alias such as `github-work` becomes the host gh
 * knows; `ssh.github.com` (SSH over 443) is github.com, as gh reads it. The
 * host itself when ssh is missing, fails or times out — the desktop's
 * `ssh_resolved_host`.
 */
export async function sshResolvedHost(host: string): Promise<string> {
  const known = sshHosts.get(host);
  if (known && (known.ok || Date.now() - known.at < createIssueTimeouts.sshFailureTtlMs)) return known.host;
  let resolved = host;
  let ok = false;
  // A plain host name only: never something ssh would read as an option.
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    const env: NodeJS.ProcessEnv = {};
    for (const k of SSH_ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
    const r = await run("ssh", ["-G", host], { env, timeoutMs: createIssueTimeouts.sshMs, killGraceMs: createIssueTimeouts.killGraceMs });
    if (!r.missing && !r.timedOut && r.code === 0) {
      const line = r.stdout.split("\n").find((l) => l.startsWith("hostname "));
      const name = line?.slice("hostname ".length).trim().toLowerCase();
      if (name) {
        resolved = name;
        ok = true;
      }
    }
  }
  if (resolved === "ssh.github.com") resolved = "github.com";
  sshHosts.set(host, { host: resolved, ok, at: Date.now() });
  return resolved;
}

/** When gh last confirmed a sign-in to a host (github.com is never checked: the call itself is). */
const signedInHosts = new Map<string, number>();

/** gh's words when it has no usable sign-in. */
const NOT_SIGNED_IN = /not logged in|no accounts|not authenticated/i;
/** gh's words when a call was refused for its sign-in (expired or missing token). */
const AUTH_REFUSED = /HTTP 401|Bad credentials|gh auth login|not logged in|authentication required/i;

/**
 * Whether `host` is a GitHub `gh` can reach: github.com, or a host gh is
 * signed in to (GitHub Enterprise) — the desktop's rule. Any other host
 * (gitlab.com, bitbucket.org…) is not GitHub.
 */
async function isGithubHost(cwd: string, host: string): Promise<true | ToolResult> {
  if (host === "github.com") return true;
  const at = signedInHosts.get(host);
  if (at !== undefined && Date.now() - at < createIssueTimeouts.signedInTtlMs) return true;
  const r = await runGh(["auth", "status", "--hostname", host], cwd, undefined, createIssueTimeouts.readMs);
  if (r.ok) {
    signedInHosts.set(host, Date.now());
    return true;
  }
  signedInHosts.delete(host);
  if (r.missing) return ghMissing();
  // gh knows no account there: not a GitHub it can reach.
  if (NOT_SIGNED_IN.test(r.stderr)) {
    return fail(
      "not_github",
      `The \`origin\` remote is on ${host}, which is not github.com nor a GitHub Enterprise host gh is signed in to (\`gh auth login --hostname ${host}\` if it is one).`,
    );
  }
  // Signed in, but the check failed (an expired token, the network): say so.
  return fail("gh_auth_failed", `gh could not check its sign-in to ${host}: ${r.stderr}`);
}

/** A target read stays good this long: a preview then its create read it once. */
const TARGETS_TTL_MS = 60_000;
const targetsCache = new Map<string, { at: number; targets: IssueTarget[] }>();

/** Previews already used by a create (filed, or perhaps filed): one create per preview. */
const usedPreviews = new Set<string>();

/** Clears what the tool remembers between calls (tests); `keepHosts` keeps the host lookups. */
export function resetCreateIssueCaches(opts: { keepHosts?: boolean } = {}): void {
  if (!opts.keepHosts) {
    sshHosts.clear();
    signedInHosts.clear();
  }
  targetsCache.clear();
  usedPreviews.clear();
}

/** Signs previews: a create must carry the id of a preview of the very same issue. */
const PREVIEW_KEY = randomBytes(32);

function previewId(issue: unknown): string {
  return createHmac("sha256", PREVIEW_KEY).update(JSON.stringify(issue)).digest("hex");
}

function samePreview(given: unknown, issue: unknown): given is string {
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(previewId(issue), "hex"));
}

/**
 * gh's words after a failed create that may still have reached GitHub: a 5xx,
 * or the connection lost (EOF, reset, timeout) — the desktop's
 * `MAY_HAVE_BEEN_CREATED` cases. A refusal (4xx, unknown label or user)
 * means nothing was filed.
 */
const MAYBE_SENT = /HTTP 5\d\d|unexpected EOF|connection reset|broken pipe|i\/o timeout|timeout awaiting|TLS handshake|stream error|GOAWAY|http2:/i;

// ─── Secrets scan ────────────────────────────────────────────

type ScanOptions = Parameters<typeof scanReportBody>[1];

/**
 * The repository's own patterns are code from the repository: a pattern that
 * backtracks forever must not freeze the server. With any, the scan runs in
 * a worker stopped after `scanMs`; built-in patterns alone run here.
 */
const SCAN_WORKER = new URL(
  // A data: URL is always an ES module, whatever package the server runs from
  // (an eval'd worker is CommonJS or ESM depending on the working directory).
  "data:text/javascript," +
    encodeURIComponent(`
import { parentPort, workerData } from "node:worker_threads";
import(workerData.core).then(
  (core) => parentPort.postMessage({ results: workerData.texts.map((t) => core.scanReportBody(t, workerData.opts)) }),
  (e) => parentPort.postMessage({ error: String(e) }),
);
`),
);

function scanTexts(texts: string[], opts: ScanOptions): Promise<ReportScan[] | null> {
  if (!opts.extraPatterns.length) return Promise.resolve(texts.map((t) => scanReportBody(t, opts)));
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(SCAN_WORKER, { workerData: { core: import.meta.resolve("@gitwand/core"), texts, opts } });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, createIssueTimeouts.scanMs);
    const end = (v: ReportScan[] | null) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(v);
    };
    worker.once("message", (m: { results?: ReportScan[] }) => end(m.results ?? null));
    worker.once("error", () => end(null));
    worker.once("exit", () => end(null));
  });
}

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
    "found, and a `previewId`. Show the user that preview with the body you passed; only once they agree, call again with the same " +
    "arguments plus `dry_run: false` and that `preview_id` (a create without it, or with changed arguments, is refused). " +
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
      preview_id: {
        type: "string",
        description: "Required with dry_run: false: the `previewId` of a preview of this very issue (same title, body, labels, assignees and target).",
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

/** Control characters (NUL, tab, newlines…): never in a title, label or login. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A list argument: absent → [], else non-empty names without commas (gh splits on them) or control characters. */
function list(v: unknown, name: string): string[] | ToolResult {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "" && !x.includes(",") && !CONTROL.test(x))) {
    return fail("invalid_list", `\`${name}\` must be a list of non-empty names, without commas or control characters.`);
  }
  return v.map((x: string) => x.trim());
}

/**
 * Title and body scanned each on its own, as the desktop form does: a finding
 * names the field (`title` / `body`) and that field's own line. Always on,
 * with the repository's `.gitwandrc` extra patterns and entropy threshold —
 * not its `secrets.ignore`: a repository (a clone, a fork) must not be able to
 * allow-list a value out of what blocks a public issue.
 */
async function scanIssue(root: string, title: string, body: string): Promise<ReportScan | null> {
  const rc = (await readGitwandrcAsync(root))?.secrets;
  const opts: ScanOptions = {
    extraPatterns: rc?.patterns ?? [],
    ignore: [],
    entropyThreshold: rc?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    blockAt: "medium",
  };
  const results = await scanTexts([title, body], opts);
  if (!results) return null;
  const out: ReportScan = { blocking: [], warnings: [] };
  results.forEach((r, i) => {
    const tag = (f: SecretFinding) => ({ ...f, file: i === 0 ? "title" : "body" });
    out.blocking.push(...r.blocking.map(tag));
    out.warnings.push(...r.warnings.map(tag));
  });
  return out;
}

/** origin's issue targets, read once a minute at most; a failure is not remembered. */
async function readTargets(root: string, host: string, remote: RemoteRepo): Promise<IssueTarget[] | { error: ToolResult }> {
  const key = `${host}/${remote.owner}/${remote.repo}`.toLowerCase();
  const hit = targetsCache.get(key);
  if (hit && Date.now() - hit.at < TARGETS_TTL_MS) return hit.targets;
  const get = (nwo: string) => runGh(["api", "--hostname", host, `repos/${nwo}`], root, undefined, createIssueTimeouts.readMs);
  const api = await get(`${remote.owner}/${remote.repo}`);
  if (!api.ok) {
    if (api.missing) return { error: ghMissing() };
    if (AUTH_REFUSED.test(api.stderr)) {
      signedInHosts.delete(host);
      return { error: fail("gh_auth_failed", `gh is not signed in to ${host}, or its token was refused: ${api.stderr}`) };
    }
    return { error: fail("target_lookup_failed", `gh could not read ${remote.owner}/${remote.repo}: ${api.stderr}`) };
  }
  const json = parseJson(api.stdout);
  // A fork's parent read on its own for the viewer's rights there; the
  // embedded copy when that read fails.
  const j = (json && typeof json === "object" ? json : {}) as Record<string, any>;
  let parent: unknown;
  if (j.fork === true && typeof j.parent?.full_name === "string") {
    const p = await get(j.parent.full_name);
    parent = p.ok ? parseJson(p.stdout) ?? undefined : undefined;
  }
  const targets = targetsFrom(json, parent);
  if (!targets.length) return { error: fail("target_lookup_failed", `gh gave no repository for ${remote.owner}/${remote.repo}.`) };
  targetsCache.set(key, { at: Date.now(), targets });
  return targets;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const ghMissing = () => fail("gh_missing", "The GitHub CLI (`gh`) is not installed or not on PATH: https://cli.github.com");

/** Characters as GitHub counts them: code points (an emoji is one). */
const chars = (s: string) => [...s].length;

/** What the server can do for a tool beyond its arguments. */
export interface ToolContext {
  /**
   * Ask the user to confirm `message` (MCP elicitation): true/false for their
   * answer, undefined when the client cannot ask.
   */
  confirm?: (message: string) => Promise<boolean | undefined>;
}

/** The question the user answers before a create, with everything that will be sent. */
function confirmMessage(repo: string, title: string, body: string, labels: string[], assignees: string[]): string {
  const lines = [`File this issue on ${repo}?`, "", `Title: ${title}`];
  if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);
  if (assignees.length) lines.push(`Assignees: ${assignees.join(", ")}`);
  lines.push("", body || "(no description)");
  return lines.join("\n");
}

export async function handleCreateIssue(cwd: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<ToolResult> {
  // 1. Arguments — nothing runs on a malformed call.
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || chars(title) > MAX_TITLE || CONTROL.test(title)) {
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
  const root = await gitTryAsync(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return fail("not_a_repo", `Not a Git repository: ${cwd}`);
  const url = await gitTryAsync(root, ["remote", "get-url", "origin"]);
  if (!url) return fail("no_origin", "This repository has no `origin` remote to file an issue on.");
  const remote = parseRemoteUrl(url);
  if (!remote) return fail("unsupported_remote", "The `origin` remote is not a `host/owner/repo` URL.");
  const host = remote.ssh ? await sshResolvedHost(remote.host) : remote.host;
  const github = await isGithubHost(root, host);
  if (github !== true) return github;

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

  // Labels and assignees need triage rights there (GitHub would drop them, or gh fail).
  if ((labels.length || assignees.length) && !chosen.canTriage) {
    return fail(
      "cannot_triage",
      `You cannot set labels or assignees on ${chosen.repo} (no triage rights there): call again without \`labels\` and \`assignees\`.`,
    );
  }

  // 4. Secrets.
  const secrets = await scanIssue(root, title, body);
  if (!secrets) {
    return fail(
      "scan_failed",
      "The secrets scan did not finish (one of the repository's `.gitwandrc` secrets patterns may never end): nothing was created.",
    );
  }
  const canCreate = secrets.blocking.length === 0;
  // What a create must match: this preview's issue, where it goes.
  const issue = [root, host, chosen.repo, title, body, labels, assignees];

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
      ...(canCreate ? { previewId: previewId(issue) } : {}),
      next: canCreate
        ? "Nothing was created. Show this preview to the user; once they agree, call again with the same arguments, dry_run: false and preview_id."
        : "Nothing was created, and this issue cannot be: remove the secrets listed in `secrets.blocking` first.",
    });
  }
  if (!canCreate) {
    return fail(
      "secrets_found",
      `Not created: ${secrets.blocking.map((f) => `${f.patternId} (${f.file} line ${f.line})`).join(", ")}. Remove the secrets and try again.`,
    );
  }
  const id = args.preview_id;
  if (!samePreview(id, issue)) {
    return fail(
      "preview_required",
      "Not created: call first without dry_run to get a preview, show it to the user, then pass its `preview_id` with the same title, body, labels, assignees and target.",
    );
  }
  if (usedPreviews.has(id)) {
    return fail("preview_used", "This preview already led to a create (filed, or perhaps filed): check the repository's issues, and preview again to file another.");
  }
  // When the client can ask, the user confirms here, not only through the agent.
  const answer = await ctx.confirm?.(confirmMessage(chosen.repo, title, body, labels, assignees));
  if (answer === false) return fail("declined", "The user declined: nothing was created.");

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
  if (made.ok || made.interrupted || MAYBE_SENT.test(made.stderr)) usedPreviews.add(id);
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

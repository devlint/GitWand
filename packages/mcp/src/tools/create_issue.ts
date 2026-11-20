/**
 * #301 part 6 — Tool `gitwand_create_issue`: file a GitHub issue on the
 * repository the agent works in, as the desktop app does.
 *
 * - Target: `origin`, or its fork parent when `origin` takes no issues
 *   (disabled or archived) — core's `issueTargetsFrom`, the mirror of Rust's
 *   `targets_from` (`commands/gh_issues.rs`).
 *   Read from `git remote get-url origin` and `gh api repos/{o}/{r}`, never
 *   from `gh repo view` alone, which may pick `upstream` (#298).
 * - Preview by default: nothing is created without `dry_run: false`.
 * - Title and body go through core's `scanReportBody` first; a known secret
 *   pattern refuses the issue.
 * - Through `gh` (its own login, or `GH_TOKEN`/`GITHUB_TOKEN`), spawned with
 *   array args and only the environment it needs.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_ENTROPY_THRESHOLD,
  issueTargetsFrom,
  scanReportBody,
  type IssueTarget,
  type ReportScan,
  type SecretFinding,
} from "@gitwand/core";
import { gitTryAsync, readGitwandrcAsync } from "../repo-config.js";
import { run } from "../spawn.js";
import { childEnv } from "../child-env.js";

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
    // Over http(s) the port is the web/API server's (gh names such a host
    // `host:port`); over ssh or git:// it is only that daemon's.
    const web = parsed.protocol === "https:" || parsed.protocol === "http:";
    return ownerRepo(web ? parsed.host : parsed.hostname, path, ssh);
  }
  // scp-like: [user@]host:path — a host has no slash, the path does not start with one.
  const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  return m ? ownerRepo(m[1], m[2], true) : null;
}

// ─── Running gh ──────────────────────────────────────────────

/** What `gh` may see beyond the shared base list (AGENTS.md: only what it needs). */
const GH_ENV_EXTRA = [
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
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // gh's keyring on Linux (Secret Service) is reached over the session bus.
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
];

/**
 * The environment `gh` runs with: the shared base list and the extras above
 * (in any case: `https_proxy` too), plus no prompt, no
 * update notice, no colour. `GH_HOST`/`GH_REPO` never pass: the target is
 * always named on the command line.
 */
export function ghEnv(): NodeJS.ProcessEnv {
  const env = childEnv(GH_ENV_EXTRA);
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
  /** A preview allows its create for this long. */
  previewTtlMs: 60 * 60_000,
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
export async function runGh(
  args: string[],
  cwd: string,
  input: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GhResult> {
  const r = await run("gh", args, {
    cwd,
    env: ghEnv(),
    input,
    timeoutMs,
    killGraceMs: createIssueTimeouts.killGraceMs,
    maxOutputBytes: createIssueTimeouts.maxOutputBytes,
    signal,
  });
  const stopped = (why: string) => ({ ok: false as const, missing: false, interrupted: true, stderr: why });
  if (r.missing) return { ok: false, missing: true, interrupted: false, stderr: "" };
  if (r.aborted) return stopped("the tool call was cancelled while gh was running");
  if (r.timedOut) return stopped(`gh did not answer within ${timeoutMs / 1000} s`);
  if (r.capped) return stopped(`gh wrote more than ${createIssueTimeouts.maxOutputBytes} bytes and was stopped`);
  if (r.signal) return stopped(`gh was stopped by ${r.signal}`);
  if (r.code !== 0) {
    return { ok: false, missing: false, interrupted: false, stderr: r.stderr.trim() || `gh exited with code ${r.code ?? "?"}` };
  }
  return { ok: true, stdout: r.stdout };
}

/** Per host: a resolved name for the server's life, a failed lookup for `sshFailureTtlMs`. */
const sshHosts = new Map<string, { host: string; ok: boolean; at: number }>();

/**
 * The host `ssh` connects to for `host` (`ssh -G` reads ~/.ssh/config
 * without connecting), so an alias such as `github-work` becomes the host gh
 * knows; `ssh.github.com` (SSH over 443) is github.com, as gh reads it. The
 * host itself when ssh is missing, fails or times out — the desktop's
 * `ssh_resolved_host`.
 */
export async function sshResolvedHost(host: string, signal?: AbortSignal): Promise<string> {
  const known = sshHosts.get(host);
  if (known && (known.ok || Date.now() - known.at < createIssueTimeouts.sshFailureTtlMs)) return known.host;
  let resolved = host;
  let ok = false;
  // A plain host name only: never something ssh would read as an option.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) {
    // Enough to find and read its config, no token.
    const r = await run("ssh", ["-G", host], {
      env: childEnv([]),
      timeoutMs: createIssueTimeouts.sshMs,
      killGraceMs: createIssueTimeouts.killGraceMs,
      signal,
    });
    // A cancelled lookup tells nothing about the host: not remembered.
    if (r.aborted) return host;
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
async function isGithubHost(cwd: string, host: string, signal?: AbortSignal): Promise<true | ToolResult> {
  if (host === "github.com") return true;
  const at = signedInHosts.get(host);
  if (at !== undefined && Date.now() - at < createIssueTimeouts.signedInTtlMs) return true;
  const r = await runGh(["auth", "status", "--hostname", host], cwd, undefined, createIssueTimeouts.readMs, signal);
  if (signal?.aborted) return cancelled();
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

/**
 * Which gh account answers: its token variables and its hosts file (`gh auth
 * switch`, a login, a logout rewrite it). Cached answers that depend on the
 * viewer (rights, `@me`) are kept per account.
 */
async function accountKey(): Promise<string> {
  const env = process.env;
  const dir =
    env.GH_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "gh") : env.APPDATA ? join(env.APPDATA, "GitHub CLI") : join(homedir(), ".config", "gh"));
  // No hosts file: tokens only.
  const mtime = await stat(join(dir, "hosts.yml")).then((st) => st.mtimeMs, () => 0);
  const tokens = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map((k) => env[k] ?? "").join("\u0000");
  return createHash("sha256").update(`${tokens}\u0000${mtime}`).digest("hex");
}

/** A target read stays good this long: a preview then its create read it once. */
const TARGETS_TTL_MS = 60_000;
const targetsCache = new Map<string, { at: number; targets: IssueTarget[] }>();

/** Previews used by a create — in flight, filed, or perhaps filed — and when: one create per preview. */
const usedPreviews = new Map<string, number>();

/** The signed-in login per host and account (`@me`). */
const logins = new Map<string, string>();

/** Clears what the tool remembers between calls (tests); `keepHosts` keeps the host lookups. */
export function resetCreateIssueCaches(opts: { keepHosts?: boolean } = {}): void {
  if (!opts.keepHosts) {
    sshHosts.clear();
    signedInHosts.clear();
  }
  targetsCache.clear();
  usedPreviews.clear();
  logins.clear();
  if (scanner) dropScanner(scanner);
}

/**
 * Signs previews: a create must carry the id of a preview of the very same
 * issue, made less than `previewTtlMs` ago. The id is the preview's time (12
 * hex digits) then an HMAC of the issue and that time, under a key of this
 * process.
 */
const PREVIEW_KEY = randomBytes(32);
const PREVIEW_ID = /^[0-9a-f]{76}$/;

function previewId(issue: unknown, at = Date.now()): string {
  const time = at.toString(16).padStart(12, "0");
  return time + createHmac("sha256", PREVIEW_KEY).update(JSON.stringify([issue, time])).digest("hex");
}

/** "ok", or why the id does not allow this create. */
function checkPreview(given: string, issue: unknown): "ok" | "mismatch" | "expired" {
  const at = parseInt(given.slice(0, 12), 16);
  const expected = previewId(issue, at);
  if (!timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"))) return "mismatch";
  return Date.now() - at >= createIssueTimeouts.previewTtlMs ? "expired" : "ok";
}

/** Marks a preview used, forgetting those old enough to have expired anyway. */
function usePreview(id: string): void {
  const now = Date.now();
  for (const [k, at] of usedPreviews) if (now - at > createIssueTimeouts.previewTtlMs) usedPreviews.delete(k);
  usedPreviews.set(id, now);
}

/**
 * Whether a failed create surely filed nothing, so it may be retried: GitHub
 * refused it (a 4xx other than 408), or the connection never opened (DNS,
 * refused, TLS). Anything else — a 5xx, a 408, a connection lost or timed out
 * mid-way, words gh never used before — may have filed it. Stricter than the
 * desktop's `post_may_have_landed`, which lists the uncertain cases instead.
 */
function sentNothing(stderr: string): boolean {
  if (/HTTP 5\d\d\b/.test(stderr)) return false;
  return /HTTP 4(?:0[0-79]|[1-9]\d)\b|no such host|connection refused|TLS handshake|x509:|certificate/i.test(stderr);
}

// ─── Secrets scan ────────────────────────────────────────────

type ScanOptions = Parameters<typeof scanReportBody>[1];

/**
 * The repository's own patterns are code from the repository: a pattern that
 * backtracks forever must not freeze the server. With any, the scan runs in
 * a worker — one, kept for the server's life and reused, replaced when a
 * scan overruns `scanMs` (counted from when it is asked, queue included,
 * but not the worker's start-up). Built-in patterns alone run here.
 */
const SCAN_WORKER = new URL(
  // A data: URL is always an ES module, whatever package the server runs from
  // (an eval'd worker is CommonJS or ESM depending on the working directory).
  "data:text/javascript," +
    encodeURIComponent(`
import { parentPort, workerData } from "node:worker_threads";
const core = await import(workerData.core);
parentPort.on("message", (m) =>
  parentPort.postMessage({ id: m.id, results: m.texts.map((t) => core.scanReportBody(t, m.opts)) }),
);
parentPort.postMessage({ ready: true });
`),
);

/** Its start-up (loading core) has its own, longer limit. */
const SCAN_WORKER_STARTUP_MS = 20_000;

interface Scanner {
  worker: Worker;
  ready: Promise<boolean>;
  /** Scans run one after the other. */
  queue: Promise<unknown>;
}

let scanner: Scanner | null = null;
let workerStarts = 0;
let scanIds = 0;

/** How many scan workers have been started (tests). */
export function scanWorkerStarts(): number {
  return workerStarts;
}

function dropScanner(s: Scanner): void {
  if (scanner === s) scanner = null;
  void s.worker.terminate();
}

function getScanner(): Scanner | null {
  if (scanner) return scanner;
  let worker: Worker;
  try {
    worker = new Worker(SCAN_WORKER, { workerData: { core: import.meta.resolve("@gitwand/core") } });
  } catch {
    return null;
  }
  workerStarts++;
  // The server's life is its stdin, not this worker.
  worker.unref();
  const s: Scanner = {
    worker,
    queue: Promise.resolve(),
    ready: new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SCAN_WORKER_STARTUP_MS);
      worker.once("message", (m: { ready?: boolean }) => {
        clearTimeout(timer);
        resolve(m.ready === true);
      });
      worker.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    }),
  };
  worker.on("exit", () => {
    if (scanner === s) scanner = null;
  });
  scanner = s;
  return s;
}

function scanInWorker(s: Scanner, texts: string[], opts: ScanOptions, timeoutMs: number): Promise<ReportScan[] | null> {
  const id = ++scanIds;
  return new Promise((resolve) => {
    // Listeners removed once answered: the worker outlives many scans.
    const finish = (v: ReportScan[] | null) => {
      clearTimeout(timer);
      s.worker.off("message", onMessage);
      s.worker.off("exit", onExit);
      resolve(v);
    };
    const timer = setTimeout(() => {
      dropScanner(s);
      finish(null);
    }, timeoutMs);
    const onMessage = (m: { id?: number; results?: ReportScan[] }) => {
      if (m.id === id) finish(m.results ?? null);
    };
    const onExit = () => finish(null);
    s.worker.on("message", onMessage);
    s.worker.on("exit", onExit);
    s.worker.postMessage({ id, texts, opts });
  });
}

/**
 * `deadline`: `scanMs` from when the scan is asked, once a worker is up —
 * time spent queued behind other scans counts, so a queue of overrunning
 * scans cannot hold a call longer than its own limit.
 */
async function scanTexts(texts: string[], opts: ScanOptions, deadline?: number): Promise<ReportScan[] | null> {
  if (!opts.extraPatterns.length) return texts.map((t) => scanReportBody(t, opts));
  const s = getScanner();
  if (!s) return null;
  // A scan already timed (queued behind one that overran) waits for a new
  // worker only as long as it has left.
  const ready =
    deadline === undefined
      ? await s.ready
      : await Promise.race([s.ready, new Promise<false>((r) => setTimeout(() => r(false), Math.max(0, deadline - Date.now())))]);
  if (!ready) {
    if (deadline === undefined || Date.now() < deadline) dropScanner(s);
    return null;
  }
  const due = deadline ?? Date.now() + createIssueTimeouts.scanMs;
  const run = s.queue.then(() => {
    const left = due - Date.now();
    if (left <= 0) return null;
    // Queued behind one that overran: that worker is gone, this one goes to a new one.
    return scanner === s ? scanInWorker(s, texts, opts, left) : scanTexts(texts, opts, due);
  });
  s.queue = run.catch(() => undefined);
  return run;
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
    "arguments plus `dry_run: false` and that `preview_id` (a create without it, with changed arguments, or more than an hour " +
    "later, is refused; one preview allows one create). " +
    "If a create returns `create_uncertain`, the issue may exist: check before calling again. " +
    "Target: the `origin` remote's repository, or its fork parent when issues are disabled (or the repository archived) on " +
    "`origin`; an explicit `repo` must be one of those two. " +
    "Title and body are scanned for secrets first: a known secret pattern (high or medium severity) refuses the issue, even " +
    "with `dry_run: false`; a high-entropy string only warns. Labels should exist on the target repository (GitHub creates a " +
    "missing one only for someone who can push there).",
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
        description: "Label names; each must already exist on the target repository.",
      },
      assignees: {
        type: "array",
        items: { type: "string" },
        description: "GitHub logins to assign (`@me` for the signed-in user).",
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

/**
 * Never in a title, label or login: control characters (C0, DEL, C1 — NUL,
 * tab, newlines, NEL), the line and paragraph separators, and the bidi
 * controls that make text read differently from what it is.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** A list argument: absent → [], else non-empty names without control characters. */
function list(v: unknown, name: string): string[] | ToolResult {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "" && !CONTROL.test(x))) {
    return fail("invalid_list", `\`${name}\` must be a list of non-empty names, without control characters.`);
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
async function scanIssue(root: string, title: string, body: string, labels: string[], assignees: string[]): Promise<ReportScan | null> {
  const rc = (await readGitwandrcAsync(root))?.secrets;
  const opts: ScanOptions = {
    extraPatterns: rc?.patterns ?? [],
    ignore: [],
    entropyThreshold: rc?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    blockAt: "medium",
  };
  // Every field that becomes public: labels and logins one per line.
  const fields: Array<[string, string]> = [
    ["title", title],
    ["body", body],
    ["labels", labels.join("\n")],
    ["assignees", assignees.join("\n")],
  ];
  const results = await scanTexts(fields.map(([, t]) => t), opts);
  if (!results) return null;
  const out: ReportScan = { blocking: [], warnings: [] };
  results.forEach((r, i) => {
    const tag = (f: SecretFinding) => ({ ...f, file: fields[i][0] });
    out.blocking.push(...r.blocking.map(tag));
    out.warnings.push(...r.warnings.map(tag));
  });
  return out;
}

interface ReadTargets {
  targets: IssueTarget[];
  /** The fork parent could not be read on its own: the viewer's rights there are unknown. */
  parentUnread: string | null;
}

/** origin's issue targets, read once a minute at most; a failure (or a partial read) is not remembered. */
async function readTargets(
  root: string,
  host: string,
  remote: RemoteRepo,
  account: string,
  signal?: AbortSignal,
): Promise<ReadTargets | { error: ToolResult }> {
  const key = `${account}/${host}/${remote.owner}/${remote.repo}`.toLowerCase();
  const hit = targetsCache.get(key);
  if (hit && Date.now() - hit.at < TARGETS_TTL_MS) return { targets: hit.targets, parentUnread: null };
  const get = (nwo: string) => runGh(["api", "--hostname", host, `repos/${nwo}`], root, undefined, createIssueTimeouts.readMs, signal);
  const api = await get(`${remote.owner}/${remote.repo}`);
  if (signal?.aborted) return { error: cancelled() };
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
  let parentUnread: string | null = null;
  if (j.fork === true && typeof j.parent?.full_name === "string") {
    const p = await get(j.parent.full_name);
    if (signal?.aborted) return { error: cancelled() };
    const read = p.ok ? parseJson(p.stdout) : null;
    // An answer that is not a repository is no better than none: the
    // embedded copy stands in, its rights unknown.
    const usable = read && typeof read === "object" && typeof (read as { full_name?: unknown }).full_name === "string";
    parent = usable ? read : undefined;
    if (!usable) parentUnread = p.ok ? "gh gave no repository" : p.stderr;
  }
  const { targets } = issueTargetsFrom(json, parent);
  if (!targets.length) return { error: fail("target_lookup_failed", `gh gave no repository for ${remote.owner}/${remote.repo}.`) };
  if (!parentUnread) targetsCache.set(key, { at: Date.now(), targets });
  return { targets, parentUnread };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The logins to send: `@me` (as gh takes it) is the signed-in login, asked once per host and account. */
async function resolveAssignees(
  root: string,
  host: string,
  assignees: string[],
  account: string,
  signal?: AbortSignal,
): Promise<string[] | ToolResult> {
  // Logins are case-insensitive on GitHub: the first spelling of each is kept.
  const unique = (xs: string[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => !seen.has(x.toLowerCase()) && (seen.add(x.toLowerCase()), true));
  };
  if (!assignees.includes("@me")) return unique(assignees);
  const key = `${account}/${host}`;
  let login = logins.get(key);
  if (!login) {
    const r = await runGh(["api", "--hostname", host, "user"], root, undefined, createIssueTimeouts.readMs, signal);
    if (signal?.aborted) return cancelled();
    if (!r.ok) {
      if (r.missing) return ghMissing();
      return fail("gh_auth_failed", `gh could not tell who \`@me\` is on ${host}: ${r.stderr}`);
    }
    const j = parseJson(r.stdout) as { login?: unknown } | null;
    if (typeof j?.login !== "string" || !j.login) return fail("gh_auth_failed", `gh could not tell who \`@me\` is on ${host}.`);
    login = j.login;
    logins.set(key, login);
  }
  return unique(assignees.map((a) => (a === "@me" ? login! : a)));
}

const cancelled = () => fail("cancelled", "The tool call was cancelled: nothing was created.");

const previewRequired = () =>
  fail(
    "preview_required",
    "Not created: call first without dry_run to get a preview, show it to the user, then pass its `preview_id` with the same title, body, labels, assignees and target.",
  );

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
  /** The tool call's: aborted when the client cancels it. */
  signal?: AbortSignal;
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
  // A create without a well-formed preview id is refused before anything runs.
  const id = args.preview_id;
  if (!dryRun && (typeof id !== "string" || !PREVIEW_ID.test(id))) return previewRequired();

  // 2. The origin remote.
  const root = await gitTryAsync(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return fail("not_a_repo", `Not a Git repository: ${cwd}`);
  const url = await gitTryAsync(root, ["remote", "get-url", "origin"]);
  if (!url) return fail("no_origin", "This repository has no `origin` remote to file an issue on.");
  const remote = parseRemoteUrl(url);
  if (!remote) return fail("unsupported_remote", "The `origin` remote is not a `host/owner/repo` URL.");
  // Every step that waits on a process stops when the client cancels the call.
  const signal = ctx.signal;
  const host = remote.ssh ? await sshResolvedHost(remote.host, signal) : remote.host;
  if (signal?.aborted) return cancelled();
  const github = await isGithubHost(root, host, signal);
  if (github !== true) return github;

  // 3. Its issue targets, as GitHub describes them.
  const account = await accountKey();
  const read = await readTargets(root, host, remote, account, signal);
  if ("error" in read) return read.error;
  const { targets, parentUnread } = read;

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
  if ((labels.length || assignees.length) && !chosen.isOrigin && parentUnread) {
    return fail("target_lookup_failed", `gh could not read your rights on ${chosen.repo} for labels and assignees: ${parentUnread}`);
  }
  if ((labels.length || assignees.length) && !chosen.canTriage) {
    return fail(
      "cannot_triage",
      `You cannot set labels or assignees on ${chosen.repo} (no triage rights there): call again without \`labels\` and \`assignees\`.`,
    );
  }
  const logins = await resolveAssignees(root, host, assignees, account, signal);
  if (!Array.isArray(logins)) return logins;

  // 4. Secrets.
  const secrets = await scanIssue(root, title, body, labels, logins);
  if (signal?.aborted) return cancelled();
  if (!secrets) {
    return fail(
      "scan_failed",
      "The secrets scan did not finish (one of the repository's `.gitwandrc` secrets patterns may never end): nothing was created.",
    );
  }
  const canCreate = secrets.blocking.length === 0;
  // What a create must match: this preview's issue, where it goes.
  // The gh account too: a preview made as one account does not create as another.
  const issue = [account, root, host, chosen.repo, title, body, labels, logins];

  if (dryRun) {
    return ok({
      dryRun: true,
      repo: chosen.repo,
      isOrigin: chosen.isOrigin,
      title,
      // The body is the caller's own text, sent verbatim: its size, not a copy.
      bodyChars,
      labels,
      assignees: logins,
      secrets,
      canCreate,
      ...(canCreate ? { previewId: previewId(issue), previewExpiresInSeconds: Math.round(createIssueTimeouts.previewTtlMs / 1000) } : {}),
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
  // Checked well-formed with the arguments (step 1).
  const given = id as string;
  const check = checkPreview(given, issue);
  if (check === "mismatch") return previewRequired();
  if (check === "expired") return fail("preview_expired", "This preview is too old: preview again, show it to the user, then create with the new `preview_id`.");
  if (usedPreviews.has(given)) {
    return fail("preview_used", "This preview already led to a create (filed, or perhaps filed): check the repository's issues, and preview again to file another.");
  }
  // Taken now, before anything is awaited: a second call with this preview,
  // at the same moment, finds it used. Given back only when nothing was sent.
  usePreview(given);
  const release = (r: ToolResult) => {
    usedPreviews.delete(given);
    return r;
  };

  // When the client can ask, the user confirms here, not only through the agent.
  let answer: boolean | undefined;
  try {
    answer = await ctx.confirm?.(confirmMessage(chosen.repo, title, body, labels, logins));
  } catch (e) {
    return release(fail("confirm_failed", `The user could not be asked to confirm (${(e as Error).message}): nothing was created.`));
  }
  if (answer === false) return release(fail("declined", "The user declined: nothing was created."));
  // The client gave up on this call (while the user read, say): its agent
  // already saw it fail, so nothing is filed behind its back. Past this
  // point a cancel stops gh, but the POST may already have reached GitHub.
  if (signal?.aborted) return release(cancelled());

  // 5. Create: the whole issue as JSON on stdin (the REST payload the desktop
  // sends), so none of it — a title holding a token, say — is on a command line.
  const payload: Record<string, unknown> = { title, body };
  if (labels.length) payload.labels = labels;
  if (logins.length) payload.assignees = logins;
  const made = await runGh(
    ["api", "--hostname", host, "-X", "POST", `repos/${chosen.repo}/issues`, "--input", "-"],
    root,
    JSON.stringify(payload),
    createIssueTimeouts.createMs,
    // Cancelled mid-POST: gh is stopped, and the issue may exist (create_uncertain).
    signal,
  );
  if (!made.ok) {
    if (made.missing) return release(ghMissing());
    if (made.interrupted || !sentNothing(made.stderr)) {
      return fail(
        "create_uncertain",
        `${made.stderr}. The issue may have been created: check https://${host}/${chosen.repo}/issues before trying again.`,
      );
    }
    return release(fail("create_failed", `gh could not create the issue on ${chosen.repo}: ${made.stderr}`));
  }
  const created = parseJson(made.stdout) as { number?: unknown; html_url?: unknown } | null;
  return ok({
    created: true,
    // "user" when the client asked the user (MCP elicitation); "agent" when
    // it cannot ask, and only the agent's preview stood for the user's yes.
    confirmedBy: answer === true ? "user" : "agent",
    repo: chosen.repo,
    number: typeof created?.number === "number" ? created.number : null,
    url: typeof created?.html_url === "string" ? created.html_url : null,
  });
}

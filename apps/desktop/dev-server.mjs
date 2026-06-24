/**
 * GitWand Dev Server
 *
 * Petit serveur HTTP qui expose les mêmes commandes que le backend Tauri,
 * pour pouvoir tester l'app Vue dans un navigateur sans Rust.
 *
 * Usage: node dev-server.mjs [--port 3001]
 * Puis lancer `pnpm dev` normalement — le frontend détecte le dev server.
 */

import { createServer } from "node:http";
import { execSync, execFileSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync, realpathSync, renameSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, dirname, basename, sep, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Socket } from "node:net";

// ── Crash guards ────────────────────────────────────────────────────────────
// Without these, any unhandled exception or rejected promise kills the process
// silently, causing "Failed to fetch" storms in the browser dev tools.
process.on("uncaughtException", (err) => {
  console.error("[dev-server] uncaughtException — server kept alive:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[dev-server] unhandledRejection — server kept alive:", reason);
});

/**
 * Resolve `relPath` under `cwd`, ensuring the result stays inside the canonical
 * cwd. Mirrors the Rust `safe_repo_path` helper in `src-tauri/src/lib.rs` so
 * dev-server and the Tauri backend enforce the same boundary.
 *
 * Throws if cwd is empty/non-absolute, relPath is empty, or the resolved path
 * escapes cwd (via `..` segments or symlink).
 */
function safeRepoPath(cwd, relPath) {
  if (!cwd || !cwd.trim()) throw new Error("cwd must not be empty");
  if (!relPath || !relPath.trim()) throw new Error("path must not be empty");
  if (!isAbsolute(cwd)) throw new Error(`cwd must be absolute (got: ${cwd})`);

  let cwdCanonical;
  try {
    cwdCanonical = realpathSync(cwd);
  } catch (e) {
    throw new Error(`cwd does not resolve: ${e.message}`);
  }

  const joined = join(cwdCanonical, relPath);

  // For writes the target file may not exist yet — canonicalize the parent
  // and reassemble the final path.
  let resolved;
  try {
    resolved = realpathSync(joined);
  } catch {
    const parent = dirname(joined);
    let parentCanonical;
    try {
      parentCanonical = realpathSync(parent);
    } catch (e) {
      throw new Error(`parent path does not resolve: ${e.message}`);
    }
    resolved = join(parentCanonical, basename(joined));
  }

  if (resolved !== cwdCanonical && !resolved.startsWith(cwdCanonical + sep)) {
    throw new Error(`path escapes cwd (resolved: ${resolved}, cwd: ${cwdCanonical})`);
  }
  return resolved;
}

/** Resolve the full path to a CLI binary, checking Homebrew paths on macOS. */
function resolveBin(name) {
  // Try common macOS Homebrew locations first
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name, // fallback: rely on PATH
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return name;
}

const GH = resolveBin("gh");
const GIT = resolveBin("git");

/**
 * Guess a MIME type from a file extension. Mirrors the Rust `guess_mime_from_ext`
 * helper. Keep the two lists in sync.
 */
function guessMimeFromExt(path) {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "bmp": return "image/bmp";
    case "ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

/**
 * Environment passed when spawning the `claude` CLI. We strip API-key env
 * vars so the CLI falls back to the OAuth session (`claude login`) — same
 * rationale as the Rust backend's `strip_claude_auth_env`.
 */
const claudeSpawnEnv = (() => {
  const clean = { ...process.env };
  delete clean.ANTHROPIC_API_KEY;
  delete clean.CLAUDE_API_KEY;
  delete clean.ANTHROPIC_AUTH_TOKEN;
  return clean;
})();
console.log(`[dev-server] gh binary:  ${GH}`);
console.log(`[dev-server] git binary: ${GIT}`);

/**
 * Run `git` with the given args, streaming stdout into memory.
 *
 * Unlike `execSync`, there's no `maxBuffer` cap — useful for huge diffs
 * (e.g. `git show` on a merge commit touching hundreds of files in a
 * monorepo, where a 10 MB cap reliably blows up).
 *
 * Resolves with the full stdout as a UTF-8 string. Rejects if git exits
 * non-zero or the process fails to spawn.
 */
function gitSpawn(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, args, { cwd });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        reject(new Error(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
    });
  });
}

// ── Mock state: GitHub OAuth device flow (dev:web only) ──────────────────────
// The real flow lives in Rust (`github_api.rs`). In the browser mock we fake it
// so the Settings > Accounts UI can be exercised without Tauri. It does NOT log
// you in — it just returns a static code then "succeeds" after a couple polls.
let _mockGithubPolls = 0;

// ── Terminal PTY state (dev:web only) ────────────────────────────────────────
const devPtys = new Map(); // id -> { proc, res }
let devPtyNextId = 1;

/**
 * Get a GitHub OAuth token — tries in order:
 *  1. GH_TOKEN / GITHUB_TOKEN env vars
 *  2. `gh auth token` CLI
 *  3. Parse ~/.config/gh/hosts.yml directly
 */
function getGithubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Try gh CLI
  try {
    const r = spawnSync(GH, ["auth", "token"], { encoding: "utf-8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ignore */ }
  // Fallback: parse hosts.yml
  try {
    const hostsFile = join(homedir(), ".config", "gh", "hosts.yml");
    const content = readFileSync(hostsFile, "utf-8");
    const m = content.match(/oauth_token:\s*(\S+)/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return null;
}

/**
 * Return "owner/repo" from the git remote origin URL in `cwd`.
 * Handles both https://github.com/owner/repo.git and git@github.com:owner/repo.git
 */
function getRepoNwo(cwd) {
  // Strategy 1: read .git/config directly — no binary needed
  try {
    const gitConfig = readFileSync(join(cwd, ".git", "config"), "utf-8");
    const m = gitConfig.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*(.+)/);
    if (m) {
      const url = m[1].trim();
      const rm = url.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (rm) return `${rm[1]}/${rm[2]}`;
    }
  } catch { /* ignore */ }
  // Strategy 2: git binary fallback
  const r = spawnSync(GIT, ["remote", "get-url", "origin"], { cwd, encoding: "utf-8" });
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
  const m = url.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Cache of resolved PR repo nwo, keyed by `<origin>#<number>`. The repo a PR
 *  lives in is stable for the PR's lifetime, so one resolution per dev-server
 *  process is enough — without this the 3 per-PR endpoints each re-resolve
 *  (up to ~9 redundant API roundtrips when a PR detail opens). */
const prNwoCache = new Map();

/**
 * Resolve the repo where PR `number` actually lives. Mirrors the Rust
 * `get_pr_json` resolution: try origin first; if the PR isn't there, fall back
 * to the fork's upstream parent. Without this, cross-fork PRs (branch pushed to
 * a fork, PR opened against the upstream repo) resolve to the fork — where the
 * PR number doesn't exist — and per-PR endpoints 404.
 *
 * Only a *definitive* answer (origin or parent confirmed) is cached; a transient
 * failure (5xx / rate limit / network) falls back to origin for this request but
 * stays uncached so a later call can re-resolve instead of pinning the wrong repo.
 */
async function resolvePrNwo(cwd, number, token) {
  const origin = getRepoNwo(cwd);
  if (!origin) return null;
  const cacheKey = `${origin}#${number}`;
  if (prNwoCache.has(cacheKey)) return prNwoCache.get(cacheKey);
  try {
    const resp = await githubFetch(`/repos/${origin}/pulls/${number}`, token);
    if (resp.ok) {
      prNwoCache.set(cacheKey, origin);
      return origin;
    }
    // PR not visible on origin (404 missing / 403 private / 410 gone) → try the
    // fork's upstream parent. Other statuses are treated as transient.
    if ([403, 404, 410].includes(resp.status)) {
      const info = await githubFetch(`/repos/${origin}`, token);
      const parent = info.ok ? (await info.json()).parent?.full_name : null;
      if (parent) {
        const r2 = await githubFetch(`/repos/${parent}/pulls/${number}`, token);
        if (r2.ok) {
          prNwoCache.set(cacheKey, parent);
          return parent;
        }
      }
    }
  } catch { /* transient — fall through without caching */ }
  return origin;
}

/** Fetch from GitHub REST API with auth. `accept` overrides the default JSON accept header. */
async function githubFetch(path, token, accept = "application/vnd.github+json") {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3001", 10);

/**
 * Allow-listed origins for CORS.
 *
 * The dev-server exposes filesystem + git commands, so an open CORS (`*`)
 * would let any page the user visits in another browser tab poke the API.
 * We restrict to the Tauri webview origin and the usual Vite/Tauri dev ports.
 */
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

/** Build CORS headers for a given request, echoing the origin only if allow-listed. */
function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

/** Parse `git log --format="%H\n%h\n%an\n%aI\n%s\n%b\n---END---"` output into FileLogEntry objects. */
function parseFileLog(raw) {
  const entries = [];
  for (const block of raw.split("---END---")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\n");
    if (parts.length < 5) continue;
    entries.push({
      hashFull: parts[0].trim(),
      hash: parts[1].trim(),
      author: parts[2].trim(),
      date: parts[3].trim(),
      message: parts[4].trim(),
      body: parts.slice(5).join("\n").trim(),
    });
  }
  return entries;
}

function jsonResponse(req, res, data, status = 200) {
  res.writeHead(status, corsHeaders(req));
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

/**
 * Extract `(host, port)` from a git remote URL.
 * Mirrors the Rust `parse_remote_host_port` helper in `commands/network.rs`.
 * Returns null when the URL is empty, has no parseable host, or uses an
 * unrecognised scheme.
 */
function parseRemoteHostPort(rawUrl) {
  const url = (rawUrl || "").trim();
  if (!url) return null;

  // SCP-style SSH: `git@host:owner/repo[.git]` (no `://`).
  if (!url.includes("://")) {
    const colon = url.indexOf(":");
    if (colon > 0) {
      const userhost = url.slice(0, colon);
      const at = userhost.lastIndexOf("@");
      const host = at >= 0 ? userhost.slice(at + 1) : userhost;
      if (host) return { host, port: 22 };
    }
    return null;
  }

  const [scheme, rest] = url.split("://", 2);
  const defaults = { https: 443, http: 80, ssh: 22, git: 9418 };
  const def = defaults[scheme.toLowerCase()];
  if (!def) return null;

  const authority = rest.split(/[\/?#]/, 1)[0] || "";
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostPort) return null;

  // IPv6 literal in brackets: `[::1]:8443`
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end < 0) return null;
    const host = hostPort.slice(1, end);
    const after = hostPort.slice(end + 1);
    const portStr = after.startsWith(":") ? after.slice(1) : "";
    const port = portStr ? Number(portStr) || def : def;
    return host ? { host, port } : null;
  }

  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon < 0) {
    return hostPort ? { host: hostPort, port: def } : null;
  }
  const host = hostPort.slice(0, lastColon);
  const portStr = hostPort.slice(lastColon + 1);
  const port = Number(portStr) || def;
  return host ? { host, port } : null;
}

/** Try a bounded TCP connect to `host:port`. Resolves true on success. */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const sock = new Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolveProbe(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

// ── Monorepo detection helpers (mirrors Rust find_workspace_packages) ────────

/**
 * Extract npm/yarn workspace glob patterns from package.json content and
 * expand them to MonorepoPackage entries. Mirrors `find_npm_workspace_packages`
 * and `extract_npm_workspace_globs` in `src/git/parse.rs`.
 */
function extractNpmWorkspacePackages(cwdResolved, pkgContent) {
  let globs = [];
  try {
    const pkg = JSON.parse(pkgContent);
    if (Array.isArray(pkg.workspaces)) {
      globs = pkg.workspaces;
    } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
      globs = pkg.workspaces.packages;
    }
  } catch { /* malformed JSON — return empty */ }

  const packages = [];
  for (const pattern of globs) {
    const noTrail = String(pattern).replace(/\/\*\*?$/, "").replace(/\*$/, "");
    const baseAbs = join(cwdResolved, noTrail);
    if (!baseAbs.startsWith(cwdResolved + sep) && baseAbs !== cwdResolved) continue;
    try {
      const entries = readdirSync(baseAbs, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const pkgJsonAbs = join(baseAbs, e.name, "package.json");
        if (!existsSync(pkgJsonAbs)) continue;
        let name = e.name, version = "";
        try {
          const meta = JSON.parse(readFileSync(pkgJsonAbs, "utf-8"));
          if (meta.name) name = meta.name;
          if (meta.version) version = meta.version;
        } catch { /* ignore — use defaults */ }
        const relPath = `${noTrail}/${e.name}`;
        packages.push({ name, path: relPath, version });
      }
    } catch { /* dir missing */ }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

/**
 * Parse Cargo.toml `[workspace] members` globs and read each member's
 * Cargo.toml for name/version. Mirrors `find_cargo_packages` in parse.rs.
 */
function findCargoPackages(cwdResolved, tomlContent) {
  const members = parseTomlStringArray(tomlContent, "members");
  const exclude = parseTomlStringArray(tomlContent, "exclude");
  const packages = [];

  for (const pattern of members) {
    const dirs = expandCargoGlob(cwdResolved, pattern);
    for (const dirRel of dirs) {
      if (exclude.includes(dirRel)) continue;
      const absDir = join(cwdResolved, dirRel);
      if (!absDir.startsWith(cwdResolved + sep) && absDir !== cwdResolved) continue;
      const memberToml = join(absDir, "Cargo.toml");
      if (!existsSync(memberToml)) continue;
      let name = basename(dirRel), version = "";
      try {
        const content = readFileSync(memberToml, "utf-8");
        const n = parseTomlScalar(content, "name");
        const v = parseTomlScalar(content, "version");
        if (n) name = n;
        if (v) version = v;
      } catch { /* ignore */ }
      packages.push({ name, path: dirRel, version });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

/** Expand a single Cargo glob like `crates/*` to relative dir paths. */
function expandCargoGlob(cwdResolved, pattern) {
  if (pattern.includes("*")) {
    const base = pattern.replace(/\/\*.*$/, "").replace(/\*.*$/, "");
    const baseAbs = join(cwdResolved, base);
    if (!baseAbs.startsWith(cwdResolved + sep) && baseAbs !== cwdResolved) return [];
    const results = [];
    try {
      const entries = readdirSync(baseAbs, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          results.push(base ? `${base}/${e.name}` : e.name);
        }
      }
    } catch { /* ignore */ }
    return results;
  }
  // Literal path
  const abs = join(cwdResolved, pattern);
  if (!abs.startsWith(cwdResolved + sep) && abs !== cwdResolved) return [];
  try { return statSync(abs).isDirectory() ? [pattern] : []; } catch { return []; }
}

/** Parse a `key = "value"` scalar from TOML content. */
function parseTomlScalar(content, key) {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    if (k !== key) continue;
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (val) return val;
  }
  return null;
}

/**
 * Parse a TOML `key = [ ... ]` (possibly multi-line) array.
 * Mirrors `parse_toml_string_array` in parse.rs.
 */
function parseTomlStringArray(content, key) {
  const needle = `${key} `;
  const needle2 = `${key}=`;
  let startIdx = -1;
  let offset = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (
      (trimmed.startsWith(needle) || trimmed.startsWith(needle2) || trimmed === key) &&
      trimmed.includes("=")
    ) {
      startIdx = offset;
      break;
    }
    offset += line.length + 1;
  }
  if (startIdx < 0) return [];
  const rest = content.slice(startIdx);
  const afterEq = rest.slice(rest.indexOf("=") + 1).trimStart();
  if (!afterEq.startsWith("[")) return [];

  let depth = 0, buf = "", found = false;
  for (const ch of afterEq) {
    if (ch === "[") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) { found = true; break; }
    }
    if (depth > 0) buf += ch;
  }
  if (!found) return [];

  // Strip comments, split on commas
  const clean = buf.split("\n").map((l) => {
    const t = l.trim();
    if (t.startsWith("#")) return "";
    const ci = t.indexOf("#");
    return ci >= 0 ? t.slice(0, ci) : t;
  }).join(" ");

  return clean.split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

/**
 * Parse go.work `use (...)` and `use ./x` directives.
 * Mirrors `find_go_packages` in parse.rs.
 */
function findGoPackages(cwdResolved, goWorkContent) {
  const packages = [];
  let inUseBlock = false;

  for (const line of goWorkContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "use (" || trimmed.startsWith("use (")) {
      inUseBlock = true;
      continue;
    }
    if (inUseBlock) {
      if (trimmed === ")") { inUseBlock = false; continue; }
      if (trimmed && !trimmed.startsWith("//")) {
        const pkg = goWorkDirToPackage(cwdResolved, trimmed);
        if (pkg) packages.push(pkg);
      }
    } else if (trimmed.startsWith("use ")) {
      const dir = trimmed.slice(4).trim();
      if (!dir.startsWith("(")) {
        const pkg = goWorkDirToPackage(cwdResolved, dir);
        if (pkg) packages.push(pkg);
      }
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

function goWorkDirToPackage(cwdResolved, dir) {
  const rel = dir.replace(/^\.\//, "") || ".";
  if (rel === ".") return null;
  const abs = join(cwdResolved, rel);
  if (!abs.startsWith(cwdResolved + sep) && abs !== cwdResolved) return null;
  try { if (!statSync(abs).isDirectory()) return null; } catch { return null; }
  const name = basename(rel);
  return { name, path: rel, version: "" };
}

/**
 * Scan apps/ and libs/ dirs (respecting nx.json workspaceLayout) for
 * subdirs with project.json or package.json. Mirrors `find_nx_packages`.
 */
function findNxPackages(cwdResolved, nxJsonContent) {
  let appsDir = "apps", libsDir = "libs";
  try {
    const nxConf = JSON.parse(nxJsonContent);
    if (nxConf.workspaceLayout) {
      if (nxConf.workspaceLayout.appsDir) appsDir = nxConf.workspaceLayout.appsDir;
      if (nxConf.workspaceLayout.libsDir) libsDir = nxConf.workspaceLayout.libsDir;
    }
  } catch { /* use defaults */ }

  const scanDirs = appsDir === libsDir ? [appsDir] : [appsDir, libsDir];
  const packages = [];

  for (const dirName of scanDirs) {
    const dirAbs = join(cwdResolved, dirName);
    if (!dirAbs.startsWith(cwdResolved + sep) && dirAbs !== cwdResolved) continue;
    try {
      const entries = readdirSync(dirAbs, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const subAbs = join(dirAbs, e.name);
        const hasProjectJson = existsSync(join(subAbs, "project.json"));
        const hasPkgJson = existsSync(join(subAbs, "package.json"));
        if (!hasProjectJson && !hasPkgJson) continue;

        let name = e.name, version = "";
        if (hasProjectJson) {
          try {
            const pj = JSON.parse(readFileSync(join(subAbs, "project.json"), "utf-8"));
            if (pj.name) name = pj.name;
          } catch { /* use dirname */ }
        } else if (hasPkgJson) {
          try {
            const pkg = JSON.parse(readFileSync(join(subAbs, "package.json"), "utf-8"));
            if (pkg.name) name = pkg.name;
            if (pkg.version) version = pkg.version;
          } catch { /* use dirname */ }
        }
        if (hasPkgJson) {
          try {
            const pkg = JSON.parse(readFileSync(join(subAbs, "package.json"), "utf-8"));
            if (pkg.version) version = pkg.version;
          } catch { /* ignore */ }
        }
        const relPath = `${dirName}/${e.name}`;
        packages.push({ name, path: relPath, version });
      }
    } catch { /* dir missing */ }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

// ────────────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  // Wrap the entire async handler so any unhandled rejection sends a 500
  // instead of crashing the server process.
  handleRequest(req, res).catch((err) => {
    console.error("[dev-server] unhandled error in request handler:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // GET /api/conflicted-files?cwd=/path/to/repo
    if (url.pathname === "/api/conflicted-files" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      const resolvedCwd = resolve(cwd);
      try {
        const stdout = execSync("git diff --name-only --diff-filter=U", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const files = stdout.trim().split("\n").filter(Boolean);
        return jsonResponse(req, res, { cwd: resolvedCwd, files });
      } catch {
        // Not a git repo or no conflicts
        // Fallback: scan for conflict markers
        const stdout = execSync(
          'grep -rl "^<<<<<<<" . --include="*" 2>/dev/null || true',
          { cwd: resolvedCwd, encoding: "utf-8" },
        );
        const files = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((f) => f.replace(/^\.\//, ""));
        return jsonResponse(req, res, { cwd: resolvedCwd, files });
      }
    }

    // GET /api/tree-conflicts?cwd=/path/to/repo  — mirrors Rust collect_tree_conflicts
    if (url.pathname === "/api/tree-conflicts" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      const resolvedCwd = resolve(cwd);
      // `-z` => NUL-terminated records with verbatim paths (mirrors Rust collect_tree_conflicts),
      // so paths with quotes/newlines/non-ASCII parse correctly.
      const out = spawnSync(GIT, ["status", "--porcelain=v2", "-z", "--untracked-files=no"], {
        cwd: resolvedCwd, encoding: "utf-8",
      });
      if (out.status !== 0) return jsonResponse(req, res, { cwd: resolvedCwd, conflicts: [] });
      const conflicts = [];
      for (const record of (out.stdout || "").split("\0")) {
        if (!record.startsWith("u ")) continue;
        const rest = record.slice(2);
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const parts = rest.split(" ");
        if (parts.length < 10) continue;
        const code = parts[0];
        const m1 = parts[2], m2 = parts[3], m3 = parts[4];
        const path = parts.slice(9).join(" ");
        if (!path) continue;
        const hasBase = m1 !== "000000";
        const hasOurs = m2 !== "000000";
        const hasTheirs = m3 !== "000000";
        if (hasOurs && hasTheirs) continue; // content conflict (UU/AA) — not a tree conflict
        conflicts.push({ path, code, hasBase, hasOurs, hasTheirs });
      }
      return jsonResponse(req, res, { cwd: resolvedCwd, conflicts });
    }

    // POST /api/resolve-tree-conflict {cwd, path, choice}  — mirrors Rust resolve_tree_conflict
    if (url.pathname === "/api/resolve-tree-conflict" && req.method === "POST") {
      const { cwd, path, choice } = await readBody(req);
      if (!cwd || !path) return jsonResponse(req, res, { error: "Missing cwd or path" }, 400);
      const resolvedCwd = resolve(cwd);
      // Traversal guard (mirrors Rust apply_tree_resolution); git still gets the relative path.
      try { safeRepoPath(resolvedCwd, path); }
      catch (e) { return jsonResponse(req, res, { error: e.message }, 400); }
      const run = (args) => {
        const r = spawnSync(GIT, args, { cwd: resolvedCwd, encoding: "utf-8" });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || ""}`);
      };
      try {
        if (choice === "ours") { run(["checkout", "--ours", "--", path]); run(["add", "--", path]); }
        else if (choice === "theirs") { run(["checkout", "--theirs", "--", path]); run(["add", "--", path]); }
        else if (choice === "delete") { run(["rm", "-f", "--", path]); }
        else return jsonResponse(req, res, { error: `unknown choice: ${choice}` }, 400);
      } catch (e) {
        return jsonResponse(req, res, { error: String(e.message || e) }, 500);
      }
      return jsonResponse(req, res, { ok: true });
    }

    // POST /api/reconstruct-conflict {cwd, path}  — mirrors Rust reconstruct_conflict
    if (url.pathname === "/api/reconstruct-conflict" && req.method === "POST") {
      const { cwd, path } = await readBody(req);
      if (!cwd || !path) return jsonResponse(req, res, { error: "Missing cwd or path" }, 400);
      const resolvedCwd = resolve(cwd);
      // Traversal guard (mirrors Rust reconstruct_conflict_impl); git still gets the relative path.
      try { safeRepoPath(resolvedCwd, path); }
      catch (e) { return jsonResponse(req, res, { error: e.message }, 400); }
      const blob = (stage) => {
        const r = spawnSync(GIT, ["show", `:${stage}:${path}`], { cwd: resolvedCwd, encoding: "buffer" });
        return r.status === 0 ? r.stdout : Buffer.alloc(0);
      };
      const base = blob(1), ours = blob(2), theirs = blob(3);
      if (ours.length === 0 && theirs.length === 0) {
        return jsonResponse(req, res, { error: `no index stages for ${path}` }, 404);
      }
      const dir = mkdtempSync(join(tmpdir(), "gitwand-recon-"));
      let content = "";
      try {
        const oursP = join(dir, "ours"), baseP = join(dir, "base"), theirsP = join(dir, "theirs");
        writeFileSync(oursP, ours); writeFileSync(baseP, base); writeFileSync(theirsP, theirs);
        const r = spawnSync(GIT, ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", oursP, baseP, theirsP], { cwd: resolvedCwd, encoding: "utf-8" });
        if (r.status === 255) return jsonResponse(req, res, { error: `git merge-file error: ${r.stderr || ""}` }, 500);
        content = r.stdout || "";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      let wt = Buffer.alloc(0);
      try { wt = readFileSync(safeRepoPath(resolvedCwd, path)); } catch { /* absent */ }
      const wtMatchesSide = (ours.length > 0 && Buffer.compare(wt, ours) === 0) ||
                            (theirs.length > 0 && Buffer.compare(wt, theirs) === 0);
      return jsonResponse(req, res, { content, wtMatchesSide });
    }

    // POST /api/read-file  { cwd, path }
    if (url.pathname === "/api/read-file" && req.method === "POST") {
      const { cwd, path } = await readBody(req);
      let fullPath;
      try { fullPath = safeRepoPath(cwd, path); }
      catch (e) { return jsonResponse(req, res, { error: e.message }, 400); }
      const content = readFileSync(fullPath, "utf-8");
      return jsonResponse(req, res, { path, content });
    }

    // POST /api/write-file  { cwd, path, content }
    if (url.pathname === "/api/write-file" && req.method === "POST") {
      const { cwd, path, content } = await readBody(req);
      let fullPath;
      try { fullPath = safeRepoPath(cwd, path); }
      catch (e) { return jsonResponse(req, res, { error: e.message }, 400); }
      writeFileSync(fullPath, content, "utf-8");
      return jsonResponse(req, res, { ok: true });
    }

    // POST /api/read-file-at-revision  { cwd, rev, path }
    //
    // Mirrors the Tauri `read_file_at_revision` command (v1.6.2 image diff).
    // - rev === ""  → read working tree from disk
    // - rev != ""  → git show <rev>:<path> as bytes
    //
    // Response: { bytesBase64, byteLength, mime, absent }.
    if (url.pathname === "/api/read-file-at-revision" && req.method === "POST") {
      const { cwd, rev, path } = await readBody(req);
      if (!cwd || !cwd.trim()) return jsonResponse(req, res, { error: "cwd must not be empty" }, 400);
      if (!path || !path.trim()) return jsonResponse(req, res, { error: "path must not be empty" }, 400);

      const mime = guessMimeFromExt(path);

      if (!rev || !rev.trim()) {
        let fullPath;
        try { fullPath = safeRepoPath(cwd, path); }
        catch (e) { return jsonResponse(req, res, { error: e.message }, 400); }
        try {
          const bytes = readFileSync(fullPath);
          return jsonResponse(req, res, {
            bytesBase64: bytes.toString("base64"),
            byteLength: bytes.length,
            mime,
            absent: false,
          });
        } catch (e) {
          if (e.code === "ENOENT") {
            return jsonResponse(req, res, { bytesBase64: "", byteLength: 0, mime, absent: true });
          }
          return jsonResponse(req, res, { error: `Failed to read ${path}: ${e.message}` }, 500);
        }
      }

      // git show <rev>:<path> — bytes
      const spec = `${rev}:${path}`;
      try {
        const bytes = execFileSync(GIT, ["show", spec], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        return jsonResponse(req, res, {
          bytesBase64: bytes.toString("base64"),
          byteLength: bytes.length,
          mime,
          absent: false,
        });
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : "";
        if (
          stderr.includes("exists on disk, but not in") ||
          stderr.includes("does not exist") ||
          stderr.includes("unknown revision") ||
          stderr.includes("Path ")
        ) {
          return jsonResponse(req, res, { bytesBase64: "", byteLength: 0, mime, absent: true });
        }
        return jsonResponse(req, res, { error: `git show ${spec} failed: ${stderr.trim() || e.message}` }, 500);
      }
    }

    // POST /api/folder-diff  { cwd, refA, refB }
    //
    // Mirrors the Tauri `folder_diff` command (v1.6.3 folder diff).
    // Aggregates file changes from `git diff -z --numstat/--name-status
    // --find-renames` into a recursive folder tree with adds/dels/files_changed
    // propagated up to every ancestor.
    //
    // Ref semantics:
    //   - both empty          → `git diff HEAD`           (working tree vs HEAD)
    //   - refA set, refB empty → `git diff <refA>`          (working tree vs refA)
    //   - both set            → `git diff <refA> <refB>`  (refB relative to refA)
    //
    // Response: single root FolderDiffNode with camelCase keys to match the
    // Tauri struct's `rename_all = "camelCase"` serialization.
    if (url.pathname === "/api/folder-diff" && req.method === "POST") {
      const { cwd, refA, refB } = await readBody(req);
      if (!cwd || !cwd.trim()) return jsonResponse(req, res, { error: "cwd must not be empty" }, 400);

      const refs = [];
      const a = (refA || "").trim();
      const b = (refB || "").trim();
      if (!a && !b) refs.push("HEAD");
      else if (!b) refs.push(a);
      else { refs.push(a); refs.push(b); }

      const runDiff = (kind) => {
        const args = ["diff", "-z", kind, "--find-renames", ...refs];
        try {
          return execFileSync(GIT, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
        } catch (e) {
          const stderr = e.stderr ? e.stderr.toString() : e.message;
          throw new Error(`git diff ${kind} failed: ${stderr.trim()}`);
        }
      };

      let nameStatusText, numstatText;
      try {
        nameStatusText = runDiff("--name-status");
        numstatText = runDiff("--numstat");
      } catch (e) {
        return jsonResponse(req, res, { error: e.message }, 500);
      }

      // Parse `--name-status -z` → list of { newPath, status, oldPath? }
      const parseNameStatus = (s) => {
        const tokens = s.split("\0").filter((t) => t.length > 0);
        const out = [];
        let i = 0;
        while (i < tokens.length) {
          const statusFull = tokens[i];
          const letter = (statusFull.charAt(0) || "M").toUpperCase();
          if (letter === "R" || letter === "C") {
            if (i + 2 < tokens.length) {
              out.push({ newPath: tokens[i + 2], status: letter, oldPath: tokens[i + 1] });
              i += 3;
            } else break;
          } else {
            if (i + 1 < tokens.length) {
              out.push({ newPath: tokens[i + 1], status: letter, oldPath: null });
              i += 2;
            } else break;
          }
        }
        return out;
      };

      // Parse `--numstat -z` → Map<newPath, { additions, deletions, binary }>
      const parseNumstat = (s) => {
        const tokens = s.split("\0");
        const out = new Map();
        let i = 0;
        while (i < tokens.length) {
          const head = tokens[i];
          if (!head) { i += 1; continue; }
          const parts = head.split("\t");
          if (parts.length < 2) { i += 1; continue; }
          const addsStr = parts[0];
          const delsStr = parts[1];
          const binary = addsStr === "-" && delsStr === "-";
          const additions = binary ? 0 : Number.parseInt(addsStr, 10) || 0;
          const deletions = binary ? 0 : Number.parseInt(delsStr, 10) || 0;
          const pathPart = parts.length >= 3 ? parts.slice(2).join("\t") : "";
          if (!pathPart) {
            // Rename header: consume next two non-empty tokens as old/new.
            let j = i + 1;
            const collected = [];
            while (j < tokens.length && collected.length < 2) {
              if (tokens[j]) collected.push(tokens[j]);
              j += 1;
            }
            if (collected.length === 2) {
              out.set(collected[1], { additions, deletions, binary });
              i = j;
            } else break;
          } else {
            out.set(pathPart, { additions, deletions, binary });
            i += 1;
          }
        }
        return out;
      };

      const nameStatus = parseNameStatus(nameStatusText);
      const numstat = parseNumstat(numstatText);

      const makeNode = (path, name, kind) => ({
        path, name, kind,
        status: null, oldPath: null,
        filesChanged: 0, additions: 0, deletions: 0,
        binary: false, children: [],
      });

      const root = makeNode("", "", "folder");

      for (const entry of nameStatus) {
        const stats = numstat.get(entry.newPath) || { additions: 0, deletions: 0, binary: false };
        const segments = entry.newPath.split("/");
        if (segments.length === 0) continue;

        root.filesChanged += 1;
        root.additions += stats.additions;
        root.deletions += stats.deletions;

        let cursor = root;
        for (let idx = 0; idx < segments.length; idx++) {
          const seg = segments[idx];
          const isLast = idx === segments.length - 1;
          const fullPath = segments.slice(0, idx + 1).join("/");
          let child = cursor.children.find((c) => c.name === seg);
          if (!child) {
            child = makeNode(fullPath, seg, isLast ? "file" : "folder");
            cursor.children.push(child);
          }
          child.filesChanged += 1;
          child.additions += stats.additions;
          child.deletions += stats.deletions;
          if (isLast) {
            child.status = entry.status;
            child.oldPath = entry.oldPath;
            child.binary = stats.binary;
            child.filesChanged = 1; // file's own count
          }
          cursor = child;
        }
      }

      // Sort: folders before files, then alphabetical.
      const sortNode = (node) => {
        node.children.sort((a, b) => {
          const af = a.kind === "folder";
          const bf = b.kind === "folder";
          if (af !== bf) return af ? -1 : 1;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        for (const c of node.children) sortNode(c);
      };
      sortNode(root);

      return jsonResponse(req, res, root);
    }

    // GET /api/list-dir?path=/some/dir  — list directories for folder picker
    if (url.pathname === "/api/list-dir" && req.method === "GET") {
      const dirPath = resolve(url.searchParams.get("path") || homedir());
      // Names that, at the home-directory level on macOS, live behind TCC
      // gating — probing `<name>/.git` triggers a permission prompt that
      // some unsigned/dev builds re-ask on every invocation. Mirror the
      // Rust backend's guard so the dev server behaves consistently.
      const MACOS_TCC_PROTECTED = new Set([
        "Documents", "Desktop", "Downloads",
        "Pictures", "Movies", "Music", "Library",
      ]);
      const atHome = dirPath === homedir();
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const dirs = entries
          .filter((e) => {
            if (!e.isDirectory()) return false;
            // Hide hidden dirs (except common ones)
            if (e.name.startsWith(".") && e.name !== ".git") return false;
            // Hide node_modules, vendor, etc.
            if (["node_modules", "__pycache__", ".Trash"].includes(e.name)) return false;
            return true;
          })
          .map((e) => ({
            name: e.name,
            path: join(dirPath, e.name),
            isGitRepo: (() => {
              if (atHome && MACOS_TCC_PROTECTED.has(e.name)) return false;
              try { statSync(join(dirPath, e.name, ".git")); return true; } catch { return false; }
            })(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const parentDir = dirname(dirPath);
        return jsonResponse(req, res, {
          current: dirPath,
          parent: parentDir !== dirPath ? parentDir : null,
          home: homedir(),
          dirs,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: `Cannot read directory: ${err.message}` }, 400);
      }
    }

    // GET /api/git-status?cwd=<path>&pathspec=<path>
    if (url.pathname === "/api/git-status" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const pathspec = url.searchParams.get("pathspec") || "";
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        // Discrete args so the optional pathspec can be passed after `--`
        // without string interpolation (v2.21.0 monorepo scope).
        const statusArgs = ["status", "--porcelain=v2", "--branch"];
        if (pathspec) statusArgs.push("--", pathspec);
        const stdout = execFileSync(GIT, statusArgs, {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });

        let branch = "unknown";
        let remote = null;
        let ahead = 0;
        let behind = 0;
        const staged = [];
        const unstaged = [];
        const untracked = [];
        const conflicted = [];

        const lines = stdout.split("\n");
        for (const line of lines) {
          if (line.startsWith("# branch.head ")) {
            branch = line.substring("# branch.head ".length).trim();
          } else if (line.startsWith("# branch.ab ")) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
              ahead = parseInt(parts[2].substring(1)) || 0;
              behind = parseInt(parts[3].substring(1)) || 0;
            }
          } else if (line.startsWith("# branch.upstream ")) {
            remote = line.substring("# branch.upstream ".length).trim();
          } else if (line.startsWith("u ")) {
            // conflicted — porcelain v2 unmerged format:
            // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            // All fields separated by spaces (no tabs)
            const parts = line.split(/\s+/);
            if (parts.length >= 11) {
              conflicted.push(parts.slice(10).join(" "));
            }
          } else if (line.startsWith("1 ")) {
            // ordinary changed entry — porcelain v2 format:
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // All fields separated by spaces (9 fields total)
            const fields = line.split(/\s+/);
            if (fields.length < 9) continue;
            const xy = fields[1];
            const path = fields.slice(8).join(" ");

            if (xy.length < 2) continue;
            const stagedChar = xy[0];
            const unstagedChar = xy[1];

            if (stagedChar !== ".") {
              const status =
                { A: "added", M: "modified", D: "deleted", R: "renamed" }[stagedChar] || "modified";
              staged.push({ path, status, oldPath: null });
            }

            if (unstagedChar !== ".") {
              const status = { M: "modified", D: "deleted" }[unstagedChar] || "modified";
              unstaged.push({ path, status, oldPath: null });
            }
          } else if (line.startsWith("2 ")) {
            // renamed/copied entry — porcelain v2 format:
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
            // Metadata separated by spaces, path and origPath by tab
            const tabIdx = line.indexOf("\t");
            const metaPart = tabIdx >= 0 ? line.substring(0, tabIdx) : line;
            const fields = metaPart.split(/\s+/);
            if (fields.length < 10) continue;
            const xy = fields[1];
            const path = fields.slice(9).join(" ");
            const origPath = tabIdx >= 0 ? line.substring(tabIdx + 1) : null;

            if (xy.length < 2) continue;
            const stagedChar = xy[0];
            const unstagedChar = xy[1];

            if (stagedChar !== ".") {
              const status =
                { A: "added", M: "modified", D: "deleted", R: "renamed" }[stagedChar] || "modified";
              staged.push({ path, status, oldPath: origPath });
            }

            if (unstagedChar !== ".") {
              const status = { M: "modified", D: "deleted" }[unstagedChar] || "modified";
              unstaged.push({ path, status, oldPath: origPath });
            }
          } else if (line.startsWith("? ")) {
            const path = line.substring("? ".length);
            if (path) untracked.push(path);
          }
        }

        // If upstream exists but ahead/behind are 0, try rev-list as fallback
        if (remote && ahead === 0 && behind === 0) {
          try {
            const abOut = execSync("git rev-list --left-right --count HEAD...@{upstream}", {
              cwd: resolvedCwd,
              encoding: "utf-8",
            }).trim();
            const [a, b] = abOut.split(/\s+/).map(Number);
            if (!isNaN(a)) ahead = a;
            if (!isNaN(b)) behind = b;
          } catch {
            // upstream may not exist, ignore
          }
        }

        // ── Remote branch existence (no upstream configured) ───────────────
        // Mirror git_status_cli: when there's no `@{u}`, the branch may still
        // be on a remote. Detect a matching remote-tracking ref and compute
        // ahead/behind against it so the UI doesn't offer to "publish" an
        // already-pushed branch. `remote` stays null — a first push still needs
        // --set-upstream.
        let remoteBranchExists = remote != null;
        if (remote == null && branch && branch !== "unknown") {
          try {
            const remotesOut = spawnSync(GIT, ["remote"], {
              cwd: resolvedCwd, encoding: "utf-8",
            });
            const names = (remotesOut.stdout || "")
              .split("\n").map((s) => s.trim()).filter(Boolean);
            const ordered = [
              ...(names.includes("origin") ? ["origin"] : []),
              ...names.filter((n) => n !== "origin"),
            ];
            for (const remoteName of ordered) {
              const candidate = `${remoteName}/${branch}`;
              const rp = spawnSync(GIT, [
                "rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`,
              ], { cwd: resolvedCwd, encoding: "utf-8" });
              if (rp.status === 0) {
                remoteBranchExists = true;
                const rl = spawnSync(GIT, [
                  "rev-list", "--left-right", "--count", `${candidate}...HEAD`,
                ], { cwd: resolvedCwd, encoding: "utf-8" });
                if (rl.status === 0) {
                  const [b, a] = (rl.stdout || "").trim().split(/\s+/).map(Number);
                  if (!isNaN(b)) behind = b;
                  if (!isNaN(a)) ahead = a;
                }
                break;
              }
            }
          } catch {
            // no remotes / detached — leave remoteBranchExists = false
          }
        }

        // ── Triangular / fork workflow ─────────────────────────────────────
        // Mirror git_status_cli: resolve @{push}; only report a separate push
        // remote (+ ahead count) when it differs from the upstream.
        let pushRemote = null;
        let aheadPush = 0;
        try {
          const pr = spawnSync(GIT, ["rev-parse", "--abbrev-ref", "@{push}"], {
            cwd: resolvedCwd, encoding: "utf-8",
          });
          if (pr.status === 0) {
            const pushRef = (pr.stdout || "").trim();
            const upstreamRef = remote || "";
            if (pushRef && pushRef !== upstreamRef) {
              const rl = spawnSync(GIT, ["rev-list", "--count", `${pushRef}..HEAD`], {
                cwd: resolvedCwd, encoding: "utf-8",
              });
              if (rl.status === 0) aheadPush = parseInt((rl.stdout || "").trim(), 10) || 0;
              pushRemote = pushRef;
            }
          }
        } catch {
          // no push remote configured — leave (null, 0)
        }

        let mainCommitCount = 1;
        const remoteRef = `origin/${branch}`;
        for (const base of ["main", "master", "origin/main", "origin/master"]) {
          try {
            const countOut = execSync(`git rev-list --count ${base}..${remoteRef}`, {
              cwd: resolvedCwd,
              encoding: "utf-8",
            }).trim();
            const count = parseInt(countOut, 10);
            if (!isNaN(count)) {
              mainCommitCount = count;
              break;
            }
          } catch {
            // base or remote ref may not exist, try next
          }
        }

        return jsonResponse(req, res, { branch, remote, remoteBranchExists, ahead, behind, mainCommitCount, pushRemote, aheadPush, staged, unstaged, untracked, conflicted });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-diff?cwd=<path>&path=<file>&staged=<bool>
    if (url.pathname === "/api/git-diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const path = url.searchParams.get("path");
      const staged = url.searchParams.get("staged") === "true";

      if (!cwd || !path) return jsonResponse(req, res, { error: "Missing cwd or path param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);

        // ── Directory: list new files inside instead of diffing ──────────
        if (path.endsWith("/")) {
          const absDir = join(resolvedCwd, path);
          let newFiles = [];
          try {
            const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard", absDir], {
              cwd: resolvedCwd, encoding: "utf-8",
            });
            newFiles = (r.stdout || "").trim().split("\n").filter(Boolean);
          } catch { /* ignore */ }
          return jsonResponse(req, res, { path, hunks: [], isDirectory: true, newFiles });
        }

        const args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
        let stdout;
        try {
          // Stream via spawn — execSync's default 1 MB cap blows up on large files
          // (lockfiles, generated assets, big migrations…).
          stdout = await gitSpawn(args, resolvedCwd);
        } catch { stdout = ""; }

        // ── New untracked file: fall back to --no-index diff (all lines green) ──
        if (!stdout.trim() && !staged) {
          const absFile = join(resolvedCwd, path);
          if (existsSync(absFile) && !statSync(absFile).isDirectory()) {
            const r = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", absFile], {
              cwd: resolvedCwd, encoding: "utf-8",
            });
            stdout = r.stdout || "";
          }
        }

        const hunks = [];
        let currentHunk = null;
        let oldLineNo = 0;
        let newLineNo = 0;

        const lines = stdout.split("\n");
        for (const line of lines) {
          if (line.startsWith("@@")) {
            if (currentHunk) hunks.push(currentHunk);

            const header = line;
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            const oldStart = match ? parseInt(match[1]) : 0;
            const oldCount = match ? parseInt(match[2] || "1") : 1;
            const newStart = match ? parseInt(match[3]) : 0;
            const newCount = match ? parseInt(match[4] || "1") : 1;

            oldLineNo = oldStart;
            newLineNo = newStart;

            currentHunk = { header, oldStart, oldCount, newStart, newCount, lines: [] };
          } else if (currentHunk) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              currentHunk.lines.push({
                type: "add",
                content: line.substring(1),
                oldLineNo: null,
                newLineNo,
              });
              newLineNo++;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              currentHunk.lines.push({
                type: "delete",
                content: line.substring(1),
                oldLineNo,
                newLineNo: null,
              });
              oldLineNo++;
            } else if (!line.startsWith("\\")) {
              const content = line.length > 0 ? line.substring(1) : "";
              currentHunk.lines.push({
                type: "context",
                content,
                oldLineNo,
                newLineNo,
              });
              oldLineNo++;
              newLineNo++;
            }
          }
        }

        if (currentHunk) hunks.push(currentHunk);

        return jsonResponse(req, res, { path, hunks });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-get-user?cwd=<path>
    if (url.pathname === "/api/git-get-user" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const { execSync } = await import("child_process");
        const name = execSync("git config user.name", { cwd: resolvedCwd, encoding: "utf8" }).trim();
        const email = execSync("git config user.email", { cwd: resolvedCwd, encoding: "utf8" }).trim();
        return jsonResponse(req, res, { name, email });
      } catch (err) {
        return jsonResponse(req, res, { name: "", email: "" });
      }
    }

    // GET /api/git-log?cwd=<path>&count=<n>&all=<bool>&author=<email>&offset=<n>&branch=<name>
    if (url.pathname === "/api/git-log" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const count = parseInt(url.searchParams.get("count") || "50");
      const offset = parseInt(url.searchParams.get("offset") || "0");
      // Default: current branch only (like `git log`). Pass `all=true` for all refs.
      const all = url.searchParams.get("all") === "true";
      const author = url.searchParams.get("author") || "";
      const branch = url.searchParams.get("branch") || "";
      const since = url.searchParams.get("since") || "";

      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        const format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";
        const args = ["log"];
        if (all) args.push("--all");
        if (author) args.push(`--author=${author}`);
        if (since) args.push(`--since=${since}`);
        if (offset > 0) args.push(`--skip=${offset}`);
        args.push(`-n${count}`);
        if (branch) args.push(branch);
        args.push(`--format=${format}`);
        // stash@{1+} are only in the reflog, not reachable via --all alone.
        if (all) {
          try {
            const stashHashes = execFileSync(GIT, ["stash", "list", "--format=%H"], { cwd: resolvedCwd, encoding: "utf-8" })
              .trim().split("\n").filter(Boolean);
            args.push(...stashHashes);
          } catch (_) { /* no stashes */ }
        }
        // Stream via spawn — execSync's default 1 MB cap can be exceeded with
        // large `count` values or commits with very long bodies.
        const stdout = await gitSpawn(args, resolvedCwd);

        const entries = [];
        const records = stdout.split("\x1e");
        for (const record of records) {
          const trimmed = record.trim();
          if (!trimmed) continue;
          const fields = trimmed.split("\x1f");
          if (fields.length < 9) continue;

          entries.push({
            hash: fields[0],
            hashFull: fields[1],
            author: fields[2],
            email: fields[3],
            date: fields[4],
            message: fields[5],
            body: fields[6].trim(),
            parents: fields[7].trim().split(/\s+/).filter(Boolean),
            refs: fields[8].trim(),
          });
        }

        return jsonResponse(req, res, entries.filter((e) => !e.message.startsWith("index on ") && !e.message.startsWith("untracked files on ")));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-rev-count?cwd=<path>&branch=<name>&all=<bool>&pathspec=<path>
    // v2.21.0 monorepo scope — count reachable commits (optionally scoped).
    if (url.pathname === "/api/git-rev-count" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const branch = url.searchParams.get("branch") || "";
      const all = url.searchParams.get("all") === "true";
      const pathspec = url.searchParams.get("pathspec") || "";

      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        const args = ["rev-list", "--count"];
        if (all) args.push("--all");
        else args.push(branch || "HEAD");
        // Discrete args — `--` then the pathspec, never interpolated.
        if (pathspec) args.push("--", pathspec);
        let count = 0;
        try {
          const stdout = execFileSync(GIT, args, { cwd: resolvedCwd, encoding: "utf-8" });
          count = parseInt(stdout.trim(), 10) || 0;
        } catch (_) {
          // Empty repo (no HEAD) → 0, mirroring the Rust command.
          count = 0;
        }
        return jsonResponse(req, res, count);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/path-exists?cwd=<path>&rel=<relpath>
    // v2.21.0 monorepo scope — validate a persisted scope path still exists.
    if (url.pathname === "/api/path-exists" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const rel = url.searchParams.get("rel");

      if (!cwd || !rel) return jsonResponse(req, res, false);

      try {
        const resolvedCwd = realpathSync(resolve(cwd));
        const target = resolve(resolvedCwd, rel);
        // Path-traversal guard: the resolved target must stay inside cwd.
        if (target !== resolvedCwd && !target.startsWith(resolvedCwd + sep)) {
          return jsonResponse(req, res, false);
        }
        return jsonResponse(req, res, existsSync(target));
      } catch {
        return jsonResponse(req, res, false);
      }
    }

    // POST /api/git-stage  { cwd, paths }
    if (url.pathname === "/api/git-stage" && req.method === "POST") {
      const { cwd, paths } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(req, res, { error: "Missing cwd or paths" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        // Remove stale index.lock if present (can happen after a crash)
        const lockFile = `${resolvedCwd}/.git/index.lock`;
        try { execSync(`rm -f "${lockFile}"`, { shell: true }); } catch { /* ignore */ }
        execSync(`git add -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
        return jsonResponse(req, res, { error: detail }, 500);
      }
    }

    // POST /api/git-unstage  { cwd, paths }
    if (url.pathname === "/api/git-unstage" && req.method === "POST") {
      const { cwd, paths } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(req, res, { error: "Missing cwd or paths" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git reset HEAD -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
        return jsonResponse(req, res, { error: detail }, 500);
      }
    }

    // POST /api/git-stage-patch  { cwd, patch }
    if (url.pathname === "/api/git-stage-patch" && req.method === "POST") {
      const { cwd, patch } = await readBody(req);
      if (!cwd || !patch) return jsonResponse(req, res, { error: "Missing cwd or patch" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git apply --cached --unidiff-zero -", {
          cwd: resolvedCwd,
          input: patch,
          encoding: "utf-8",
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-unstage-patch  { cwd, patch }
    if (url.pathname === "/api/git-unstage-patch" && req.method === "POST") {
      const { cwd, patch } = await readBody(req);
      if (!cwd || !patch) return jsonResponse(req, res, { error: "Missing cwd or patch" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git apply --cached --reverse --unidiff-zero -", {
          cwd: resolvedCwd,
          input: patch,
          encoding: "utf-8",
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-commit  { cwd, message }
    if (url.pathname === "/api/git-commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return jsonResponse(req, res, { error: "Missing cwd or message" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execFileSync("git", ["commit", "-m", message], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const hash = execSync("git rev-parse --short HEAD", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        }).trim();
        return jsonResponse(req, res, { hash });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-amend-commit  { cwd, message }
    if (url.pathname === "/api/git-amend-commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return jsonResponse(req, res, { error: "Missing cwd or message" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execFileSync("git", ["commit", "--amend", "-m", message], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const hash = execSync("git rev-parse --short HEAD", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        }).trim();
        return jsonResponse(req, res, { hash });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-split-commit  { cwd, firstPatch, firstMessage, secondMessage }
    // Splits HEAD commit into two. Requires clean working tree.
    // Workflow: reset --mixed HEAD^ → apply firstPatch → commit firstMessage
    //         → add -A . → commit secondMessage
    // On any failure, rolls back to the original HEAD via git reset --hard.
    if (url.pathname === "/api/git-split-commit" && req.method === "POST") {
      const { cwd, firstPatch, firstMessage, secondMessage } = await readBody(req);
      if (!cwd || !firstPatch || !firstMessage || !secondMessage) {
        return jsonResponse(req, res, { error: "Missing cwd, firstPatch, firstMessage, or secondMessage" }, 400);
      }
      const resolvedCwd = resolve(cwd);
      let originalSha = null;
      const rollback = () => {
        if (!originalSha) return;
        try {
          execFileSync("git", ["reset", "--hard", originalSha], {
            cwd: resolvedCwd,
            encoding: "utf-8",
          });
        } catch {
          // best-effort
        }
      };
      try {
        // 1. Save original HEAD
        originalSha = execSync("git rev-parse HEAD", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        }).trim();

        // 2. Precondition: clean working tree
        const status = execSync("git status --porcelain", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        if (status.trim().length > 0) {
          return jsonResponse(
            req,
            res,
            {
              error:
                "Working tree must be clean before splitting a commit — commit, stash, or discard your changes first.",
            },
            400,
          );
        }

        // 2b. Precondition: HEAD must be a non-merge commit. `git reset --mixed
        // HEAD^` on a merge would silently follow the first-parent only and
        // drop the second parent from history — flattening the merge. Refuse.
        const parentsLine = execSync("git rev-list --parents -n 1 HEAD", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        }).trim();
        // Format: "<sha> <parent1> [<parent2> …]"
        const parentCount = Math.max(0, parentsLine.split(/\s+/).length - 1);
        if (parentCount === 0) {
          return jsonResponse(
            req,
            res,
            { error: "Cannot split the root commit — it has no parent to reset onto." },
            400,
          );
        }
        if (parentCount > 1) {
          return jsonResponse(
            req,
            res,
            {
              error:
                "Cannot split a merge commit — splitting would flatten the merge and drop one of its parents from history.",
            },
            400,
          );
        }

        // 3. Undo HEAD, changes become unstaged
        execFileSync("git", ["reset", "--mixed", "HEAD^"], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }

      // On failure we dump the patch we fed to `git apply` — a failed apply
      // reports a single line of stderr, so the patch content is the only
      // way to diagnose format regressions (phantom context lines, missing
      // `new file mode`, etc.). Written lazily inside the catch branch below
      // so the happy path stays silent.
      let debugPatchPath = null;

      try {
        // 4. Stage first patch
        execSync("git apply --cached --unidiff-zero -", {
          cwd: resolvedCwd,
          input: firstPatch,
          encoding: "utf-8",
        });

        // 5. Commit A
        execFileSync("git", ["commit", "-m", firstMessage], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const firstHash = execSync("git rev-parse --short HEAD", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        }).trim();

        // 6. Stage everything remaining (working tree ↔ index = inverse of firstPatch)
        execFileSync("git", ["add", "-A", "."], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });

        // 7. Commit B
        execFileSync("git", ["commit", "-m", secondMessage], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const secondHash = execSync("git rev-parse --short HEAD", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        }).trim();

        return jsonResponse(req, res, { firstHash, secondHash });
      } catch (err) {
        rollback();
        const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
        try {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { tmpdir } = await import("node:os");
          const { join } = await import("node:path");
          const dir = join(tmpdir(), "gitwand-split-debug");
          mkdirSync(dir, { recursive: true });
          debugPatchPath = join(dir, `patch-${Date.now()}.diff`);
          writeFileSync(debugPatchPath, firstPatch, "utf-8");
        } catch {
          // Best effort — don't mask the real error with a dump failure.
        }
        console.error(
          `[split-commit] apply failed: ${detail}\n` +
          `  patch kept at: ${debugPatchPath ?? "(not saved)"}\n` +
          `  head was: ${originalSha ?? "?"}`,
        );
        return jsonResponse(req, res, { error: detail, debugPatchPath }, 500);
      }
    }

    // POST /api/git-push  { cwd, setUpstream?, force? }
    if (url.pathname === "/api/git-push" && req.method === "POST") {
      const { cwd, setUpstream, force } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        let cmd = "git push";
        if (setUpstream) cmd += " --set-upstream origin HEAD";
        if (force) cmd += " --force-with-lease";
        cmd += " 2>&1";
        const stdout = execSync(cmd, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: ((err.stdout || "") + (err.stderr || "")).toString().trim() || err.message });
      }
    }

    // POST /api/git-fetch  { cwd }
    if (url.pathname === "/api/git-fetch" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git fetch --prune 2>&1", {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
          timeout: 15000,
        });
        return jsonResponse(req, res, { success: true });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: ((err.stdout || "") + (err.stderr || "")).toString().trim() || err.message });
      }
    }

    // POST /api/git-merge  { cwd, branch }
    if (url.pathname === "/api/git-merge" && req.method === "POST") {
      const { cwd, branch } = await readBody(req);
      if (!cwd || !branch) return jsonResponse(req, res, { success: false, message: "Missing cwd or branch" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync(`git merge "${branch}" 2>&1`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { success: true, message: stdout.trim() || "Merge completed" });
      } catch (err) {
        // Merge conflicts are not fatal — check if it's a conflict vs real error
        const stderr = (err.stderr || "").toString();
        const stdout = (err.stdout || "").toString();
        const combined = stderr + stdout;
        const isConflict = combined.includes("CONFLICT") || combined.includes("Automatic merge failed");
        return jsonResponse(req, res, {
          success: false,
          conflicts: isConflict,
          message: isConflict ? "Merge conflicts detected" : (stderr || stdout || err.message || "Merge failed").trim(),
        });
      }
    }

    // POST /api/git-merge-continue  { cwd }
    if (url.pathname === "/api/git-merge-continue" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { success: false, message: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync('git -c core.editor=true merge --continue 2>&1', {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
          env: { ...process.env, GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true" },
        });
        return jsonResponse(req, res, { success: true, message: stdout.trim() || "Merge completed" });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: (err.stderr || err.stdout || err.message || "").toString().trim() });
      }
    }

    // POST /api/git-merge-abort  { cwd }
    if (url.pathname === "/api/git-merge-abort" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { success: false, message: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git merge --abort 2>&1", {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { success: true, message: "Merge aborted" });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: ((err.stdout || "") + (err.stderr || "")).toString().trim() || err.message });
      }
    }

    // POST /api/git-cherry-pick  { cwd, hashes }
    if (url.pathname === "/api/git-cherry-pick" && req.method === "POST") {
      const { cwd, hashes } = await readBody(req);
      if (!cwd || !Array.isArray(hashes) || hashes.length === 0)
        return jsonResponse(req, res, { success: false, message: "Missing cwd or hashes" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const { spawnSync } = await import("child_process");
        const result = spawnSync("git", ["cherry-pick", ...hashes], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const stdout = result.stdout || "";
        const stderr = result.stderr || "";
        const combined = stdout + stderr;
        const hasConflicts = combined.includes("CONFLICT") || combined.includes("conflict");
        const success = result.status === 0;
        return jsonResponse(req, res, {
          success,
          conflicts: hasConflicts,
          message: success ? stdout.trim() : (stderr.trim() || stdout.trim() || "Cherry-pick failed"),
        });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: err.message || "Cherry-pick failed" });
      }
    }

    // POST /api/git-cherry-pick-abort  { cwd }
    if (url.pathname === "/api/git-cherry-pick-abort" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { success: false, message: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git cherry-pick --abort 2>&1", { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(req, res, { success: true, message: "Cherry-pick aborted" });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: ((err.stdout || "") + (err.stderr || "")).toString().trim() || err.message });
      }
    }

    // POST /api/git-cherry-pick-continue  { cwd }
    if (url.pathname === "/api/git-cherry-pick-continue" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { success: false, message: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync("git cherry-pick --continue 2>&1", {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
          env: { ...process.env, GIT_EDITOR: "true" },
        });
        const hasConflicts = stdout.includes("CONFLICT") || stdout.includes("conflict");
        return jsonResponse(req, res, { success: !hasConflicts, conflicts: hasConflicts, message: stdout.trim() });
      } catch (err) {
        const combined = ((err.stderr || "") + (err.stdout || "")).toString();
        const hasConflicts = combined.includes("CONFLICT") || combined.includes("conflict");
        return jsonResponse(req, res, {
          success: false,
          conflicts: hasConflicts,
          message: (err.stderr || err.stdout || err.message || "").toString().trim(),
        });
      }
    }

    // POST /api/git-pull  { cwd, rebase? }
    if (url.pathname === "/api/git-pull" && req.method === "POST") {
      const { cwd, rebase } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        // Explicit strategy flag so the user's pull-mode choice wins over the
        // ambient `pull.rebase` git config (parity with the Rust git_pull cmd).
        const cmd = rebase ? "git pull --rebase 2>&1" : "git pull --no-rebase 2>&1";
        const stdout = execSync(cmd, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: ((err.stdout || "") + (err.stderr || "")).toString().trim() || err.message });
      }
    }

    // POST /api/git-repo-state  { cwd }
    if (url.pathname === "/api/git-repo-state" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const { execSync: es } = await import("node:child_process");
        const fs = await import("node:fs");
        const path = await import("node:path");

        // Resolve .git dir
        const gitDirRaw = es("git rev-parse --git-dir", { cwd: resolvedCwd, encoding: "utf-8" }).trim();
        const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(resolvedCwd, gitDirRaw);

        const readTrimmed = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return null; } };
        const readU32 = (p) => { const s = readTrimmed(p); return s ? (parseInt(s, 10) || 0) : 0; };
        const hasConflict = () => {
          try {
            const out = es("git status --porcelain", { cwd: resolvedCwd, encoding: "utf-8" });
            return out.split("\n").some(l => ["UU","AA","UD","DU","AU","UA"].includes(l.slice(0,2)));
          } catch { return false; }
        };

        const rebaseMerge = path.join(gitDir, "rebase-merge");
        if (fs.existsSync(rebaseMerge)) {
          const isInteractive = fs.existsSync(path.join(rebaseMerge, "interactive"));
          return jsonResponse(req, res, {
            state: isInteractive ? "rebase_interactive" : "rebase",
            hasConflict: hasConflict(),
            operationHead: readTrimmed(path.join(gitDir, "REBASE_HEAD")),
            targetBranch: (readTrimmed(path.join(rebaseMerge, "head-name")) || "").replace("refs/heads/", "") || null,
            step: readU32(path.join(rebaseMerge, "msgnum")),
            total: readU32(path.join(rebaseMerge, "end")),
          });
        }
        const rebaseApply = path.join(gitDir, "rebase-apply");
        if (fs.existsSync(rebaseApply)) {
          return jsonResponse(req, res, {
            state: "rebase",
            hasConflict: hasConflict(),
            operationHead: readTrimmed(path.join(gitDir, "REBASE_HEAD")),
            targetBranch: (readTrimmed(path.join(rebaseApply, "head-name")) || "").replace("refs/heads/", "") || null,
            step: readU32(path.join(rebaseApply, "next")),
            total: readU32(path.join(rebaseApply, "last")),
          });
        }
        for (const [head, state] of [["MERGE_HEAD","merge"],["CHERRY_PICK_HEAD","cherry_pick"],["REVERT_HEAD","revert"]]) {
          const headFile = path.join(gitDir, head);
          if (fs.existsSync(headFile)) {
            return jsonResponse(req, res, { state, hasConflict: hasConflict(), operationHead: readTrimmed(headFile), targetBranch: null, step: 0, total: 0 });
          }
        }
        return jsonResponse(req, res, { state: "clean", hasConflict: false, operationHead: null, targetBranch: null, step: 0, total: 0 });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-rebase-action  { cwd, action: "continue"|"abort"|"skip" }
    if (url.pathname === "/api/git-rebase-action" && req.method === "POST") {
      const { cwd, action } = await readBody(req);
      if (!cwd || !["continue","abort","skip"].includes(action))
        return jsonResponse(req, res, { error: "Missing cwd or invalid action" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git rebase --${action}`, { cwd: resolvedCwd, encoding: "utf-8", shell: true, env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" } });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr || err.message }, 500);
      }
    }

    // GET /api/git-file-diff?cwd=<path>&path=<file>&from=<hash>&to=<hash>
    if (url.pathname === "/api/git-file-diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const fromHash = url.searchParams.get("from");
      const toHash = url.searchParams.get("to");
      if (!cwd || !filePath || !fromHash || !toHash) return jsonResponse(req, res, { error: "Missing params" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        // Stream via spawn — explicit 10 MB cap can still be exceeded on
        // large file rewrites between two distant commits.
        const stdout = await gitSpawn(
          ["diff", fromHash, toHash, "--", filePath],
          resolvedCwd,
        );

        const hunks = [];
        let currentHunk = null;
        let oldLineNo = 0;
        let newLineNo = 0;

        const diffLines = stdout.split("\n");
        for (const line of diffLines) {
          if (line.startsWith("@@")) {
            if (currentHunk) hunks.push(currentHunk);
            const header = line;
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            const oldStart = match ? parseInt(match[1]) : 0;
            const oldCount = match ? parseInt(match[2] || "1") : 1;
            const newStart = match ? parseInt(match[3]) : 0;
            const newCount = match ? parseInt(match[4] || "1") : 1;
            oldLineNo = oldStart;
            newLineNo = newStart;
            currentHunk = { header, oldStart, oldCount, newStart, newCount, lines: [] };
          } else if (currentHunk) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              currentHunk.lines.push({ type: "add", content: line.substring(1), oldLineNo: null, newLineNo });
              newLineNo++;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              currentHunk.lines.push({ type: "delete", content: line.substring(1), oldLineNo, newLineNo: null });
              oldLineNo++;
            } else if (line.startsWith(" ")) {
              // Real context line: space + content (possibly empty). An empty
              // source-line renders as " " (length 1), not "" (length 0) — the
              // truly-empty strings produced by split("\n") on the blank
              // separator between diff sections are NOT context. Treating them
              // as context adds a phantom line that corrupts the hunk counts
              // and makes `git apply` reject the patch (with e.g. "new file X
              // depends on old contents" for a purely-additive hunk).
              currentHunk.lines.push({ type: "context", content: line.substring(1), oldLineNo, newLineNo });
              oldLineNo++;
              newLineNo++;
            }
            // else: skip. Covers "" blank separators, "\ No newline at end of
            // file" markers, and anything else that isn't a real hunk line.
          }
        }
        if (currentHunk) hunks.push(currentHunk);

        return jsonResponse(req, res, { path: filePath, hunks });
      } catch (err) {
        // Empty diff if identical
        if (err.status === 0 || (err.stdout && err.stdout.trim() === "")) {
          return jsonResponse(req, res, { path: filePath, hunks: [] });
        }
        return jsonResponse(req, res, { path: filePath, hunks: [] });
      }
    }

    // POST /api/git-discard  { cwd, paths, untracked? }
    // Pour les fichiers non-suivis (untracked), utiliser git clean -f
    // Pour les fichiers suivis modifiés, utiliser git restore (ou checkout --)
    if (url.pathname === "/api/git-discard" && req.method === "POST") {
      const { cwd, paths, untracked } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(req, res, { error: "Missing cwd or paths" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        if (untracked) {
          // Fichiers non-suivis → git clean -f
          execSync(`git clean -f -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
            cwd: resolvedCwd,
            encoding: "utf-8",
            shell: true,
          });
        } else {
          // Fichiers suivis modifiés → git restore
          execSync(`git restore -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
            cwd: resolvedCwd,
            encoding: "utf-8",
            shell: true,
          });
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.message, stderr: err.stderr }, 500);
      }
    }

    // POST /api/git-gitignore  { cwd, path }
    // Ajoute le chemin au fichier .gitignore du repo
    if (url.pathname === "/api/git-gitignore" && req.method === "POST") {
      const { cwd, path: filePath } = await readBody(req);
      if (!cwd || !filePath) return jsonResponse(req, res, { error: "Missing cwd or path" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const gitignorePath = join(resolvedCwd, ".gitignore");
        // Lire le .gitignore existant (ou créer vide)
        let existing = "";
        try { existing = readFileSync(gitignorePath, "utf-8"); } catch {}
        // Vérifier si l'entrée existe déjà
        const lines = existing.split("\n");
        if (!lines.includes(filePath)) {
          const newContent = existing.endsWith("\n") || existing === ""
            ? existing + filePath + "\n"
            : existing + "\n" + filePath + "\n";
          writeFileSync(gitignorePath, newContent, "utf-8");
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-show?cwd=<path>&hash=<commit>
    if (url.pathname === "/api/git-show" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const hash = url.searchParams.get("hash");
      if (!cwd || !hash) return jsonResponse(req, res, { error: "Missing cwd or hash param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        // Use -m --first-parent to handle merge commits (otherwise diff is empty/combined).
        // Stream stdout via spawn — execSync's maxBuffer (10 MB) is exceeded by large
        // merge commits in monorepos and causes a 500.
        const stdout = await gitSpawn(
          ["show", "-m", "--first-parent", "--format=", hash],
          resolvedCwd,
        );

        const diffs = [];
        let currentPath = null;
        let currentHunk = null;
        let currentHunks = [];
        let oldLineNo = 0;
        let newLineNo = 0;
        // File-level extended header state — see Rust `git_show` for rationale.
        // The frontend's patchBuilder needs to know whether a file was added
        // (uses /dev/null as source) or deleted (uses /dev/null as target) or
        // the `git apply --cached` during a split will fail.
        let currentStatus = null;
        let currentOldPath = null;

        for (const line of stdout.split("\n")) {
          if (line.startsWith("diff --git ")) {
            if (currentHunk) currentHunks.push(currentHunk);
            currentHunk = null;
            if (currentPath) {
              diffs.push({
                path: currentPath,
                hunks: currentHunks,
                ...(currentStatus ? { status: currentStatus } : {}),
                ...(currentOldPath ? { oldPath: currentOldPath } : {}),
              });
              currentHunks = [];
            }
            currentStatus = null;
            currentOldPath = null;
            const parts = line.split(" b/");
            currentPath = parts.length >= 2 ? parts[1] : null;
          } else if (line.startsWith("new file mode")) {
            currentStatus = "added";
          } else if (line.startsWith("deleted file mode")) {
            currentStatus = "deleted";
          } else if (line.startsWith("rename from ")) {
            currentStatus = "renamed";
            currentOldPath = line.substring("rename from ".length);
          } else if (line.startsWith("rename to ") && !currentStatus) {
            currentStatus = "renamed";
          } else if (line.startsWith("@@")) {
            if (currentHunk) currentHunks.push(currentHunk);

            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            const oldStart = match ? parseInt(match[1]) : 0;
            const oldCount = match ? parseInt(match[2] || "1") : 1;
            const newStart = match ? parseInt(match[3]) : 0;
            const newCount = match ? parseInt(match[4] || "1") : 1;
            oldLineNo = oldStart;
            newLineNo = newStart;

            currentHunk = { header: line, oldStart, oldCount, newStart, newCount, lines: [] };
          } else if (currentHunk) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              currentHunk.lines.push({ type: "add", content: line.substring(1), oldLineNo: null, newLineNo });
              newLineNo++;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              currentHunk.lines.push({ type: "delete", content: line.substring(1), oldLineNo, newLineNo: null });
              oldLineNo++;
            } else if (line.startsWith(" ")) {
              // Real context line: space + content (possibly empty). An empty
              // source-line renders as " " (length 1), not "" (length 0) — the
              // truly-empty strings produced by split("\n") on the blank
              // separator between diff sections are NOT context. Treating them
              // as context adds a phantom line that corrupts the hunk counts
              // and makes `git apply` reject the patch (with e.g. "new file X
              // depends on old contents" for a purely-additive hunk).
              currentHunk.lines.push({ type: "context", content: line.substring(1), oldLineNo, newLineNo });
              oldLineNo++;
              newLineNo++;
            }
            // else: skip. Covers "" blank separators, "\ No newline at end of
            // file" markers, and anything else that isn't a real hunk line.
          }
        }

        if (currentHunk) currentHunks.push(currentHunk);
        if (currentPath) {
          diffs.push({
            path: currentPath,
            hunks: currentHunks,
            ...(currentStatus ? { status: currentStatus } : {}),
            ...(currentOldPath ? { oldPath: currentOldPath } : {}),
          });
        }

        return jsonResponse(req, res, diffs);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-branches?cwd=<path>
    if (url.pathname === "/api/git-branches" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const mainName = (() => {
          for (const name of ["main", "master", "origin/main", "origin/master"]) {
            try {
              execSync(`git rev-parse --verify ${name}`, { cwd: resolvedCwd, stdio: "ignore" });
              return name;
            } catch { /* next */ }
          }
          return "main";
        })();

        // KEEP IN SYNC with git_branches in src-tauri/src/commands/ops.rs —
        // same positional field order and date format must be used in both.
        const format = `%(HEAD)%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(objectname:short) %(subject)\x1f%(committerdate:iso-strict)\x1f%(ahead-behind:${mainName})`;
        const stdout = execSync(`git branch -a --format="${format}"`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });

        const mainCounts = new Map();
        const rawBranches = [];
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const isCurrent = trimmed.startsWith("*");
          const rest = isCurrent ? trimmed.substring(1) : trimmed;
          const parts = rest.split("\x1f");
          if (parts.length < 4) continue;

          const name = parts[0];
          const upstream = parts[1] || null;
          const trackInfo = parts[2] || "";
          const lastCommit = parts[3] || "";
          const lastCommitDate = parts[4] || "";
          const mainCount = parseInt((parts[5] || "0").split(/\s+/)[0], 10) || 0;

          if (name.includes("HEAD ->") || name === "origin/HEAD") continue;

          let ahead = 0, behind = 0;
          for (const part of trackInfo.split(", ")) {
            if (part.startsWith("ahead ")) ahead = parseInt(part.substring(6)) || 0;
            if (part.startsWith("behind ")) behind = parseInt(part.substring(7)) || 0;
          }

          const isRemote = name.startsWith("origin/") || name.startsWith("remotes/");
          const cleanName = name.startsWith("remotes/") ? name.slice(8) : name;

          mainCounts.set(cleanName, mainCount);

          rawBranches.push({
            name: cleanName,
            isCurrent,
            isRemote,
            upstream,
            ahead,
            behind,
            mainCommitCount: 0,
            lastCommit,
            lastCommitDate,
          });
        }

        const branches = rawBranches.map((b) => {
          if (b.isRemote) {
            b.mainCommitCount = mainCounts.get(b.name) || 0;
          } else if (b.upstream) {
            b.mainCommitCount = mainCounts.get(b.upstream) || 0;
          } else {
            b.mainCommitCount = 0;
          }
          return b;
        });

        return jsonResponse(req, res, branches);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-create-branch  { cwd, name, checkout, startPoint? }
    if (url.pathname === "/api/git-create-branch" && req.method === "POST") {
      const { cwd, name, checkout, startPoint } = await readBody(req);
      if (!cwd || !name) return jsonResponse(req, res, { error: "Missing cwd or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const sp = startPoint ? [startPoint] : [];
        if (checkout) {
          execFileSync(GIT, ["checkout", "-b", name, ...sp], { cwd: resolvedCwd });
        } else {
          execFileSync(GIT, ["branch", name, ...sp], { cwd: resolvedCwd });
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-switch-branch  { cwd, name }
    if (url.pathname === "/api/git-switch-branch" && req.method === "POST") {
      const { cwd, name } = await readBody(req);
      if (!cwd || !name) return jsonResponse(req, res, { error: "Missing cwd or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git checkout "${name}"`, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-delete-branch  { cwd, name, force }
    if (url.pathname === "/api/git-delete-branch" && req.method === "POST") {
      const { cwd, name, force } = await readBody(req);
      if (!cwd || !name) return jsonResponse(req, res, { error: "Missing cwd or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const flag = force ? "-D" : "-d";
        execSync(`git branch ${flag} "${name}"`, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-delete-remote-branch  { cwd, remote, name }
    if (url.pathname === "/api/git-delete-remote-branch" && req.method === "POST") {
      const { cwd, remote, name } = await readBody(req);
      if (!cwd || !remote || !name) return jsonResponse(req, res, { error: "Missing cwd, remote, or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execFileSync("git", ["push", remote, "--delete", name], { cwd: resolvedCwd, encoding: "utf-8" });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-rename-branch  { cwd, oldName, newName }
    if (url.pathname === "/api/git-rename-branch" && req.method === "POST") {
      const { cwd, oldName, newName } = await readBody(req);
      if (!cwd || !oldName || !newName) return jsonResponse(req, res, { error: "Missing cwd, oldName or newName" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git branch -m "${oldName}" "${newName}"`, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-stash  { cwd, message? }
    if (url.pathname === "/api/git-stash" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const args = ["stash", "push", "--include-untracked"];
        const trimmed = typeof message === "string" ? message.trim() : "";
        if (trimmed) {
          args.push("-m", trimmed);
        }
        execFileSync("git", args, { cwd: resolvedCwd, encoding: "utf-8" });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-stash-pop  { cwd }
    if (url.pathname === "/api/git-stash-pop" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git stash pop", { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-stash-list?cwd=<path>
    // Returns StashEntry[] — empty array when there are no stashes (not an error).
    if (url.pathname === "/api/git-stash-list" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const out = execFileSync(
          "git",
          ["stash", "list", "--format=%H%x09%gd%x09%gs%x09%ct"],
          { cwd: resolvedCwd, encoding: "utf-8" },
        );
        // Mirror git_stash_list (Rust) parsing exactly so the parity test holds:
        //   - "On <branch>: <custom-message>"           → branch, custom message
        //   - "WIP on <branch>: <sha> <commit-subject>" → branch, subject (sha dropped)
        //   - "untracked files on <branch>: …"          → skipped (internal commit)
        const entries = [];
        out
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line, i) => {
            const [hash, , subjectRaw, ts] = line.split("\t");
            const subject = subjectRaw ?? "";
            if (subject.startsWith("untracked files on ")) return;
            const date = ts ? new Date(parseInt(ts, 10) * 1000).toISOString() : "";
            let branch = "";
            let message = subject;
            if (subject.startsWith("On ")) {
              const colon = subject.indexOf(": ");
              if (colon !== -1) {
                branch = subject.slice(3, colon);
                message = subject.slice(colon + 2);
              }
            } else if (subject.startsWith("WIP on ")) {
              const colon = subject.indexOf(": ");
              if (colon !== -1) {
                branch = subject.slice(7, colon);
                const rest = subject.slice(colon + 2);
                // drop the leading "<sha> " from the commit message portion
                const sp = rest.indexOf(" ");
                message = sp !== -1 ? rest.slice(sp + 1) : rest;
              }
            }
            entries.push({ index: i, hash, message, branch, date });
          });
        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-stash-apply  { cwd, index }
    if (url.pathname === "/api/git-stash-apply" && req.method === "POST") {
      const { cwd, index } = await readBody(req);
      if (!cwd || typeof index !== "number") {
        return jsonResponse(req, res, { error: "Missing cwd or index" }, 400);
      }
      try {
        const resolvedCwd = resolve(cwd);
        execFileSync("git", ["stash", "apply", `stash@{${index}}`], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-stash-drop  { cwd, index }
    if (url.pathname === "/api/git-stash-drop" && req.method === "POST") {
      const { cwd, index } = await readBody(req);
      if (!cwd || typeof index !== "number") {
        return jsonResponse(req, res, { error: "Missing cwd or index" }, 400);
      }
      try {
        const resolvedCwd = resolve(cwd);
        execFileSync("git", ["stash", "drop", `stash@{${index}}`], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-stash-clear  { cwd }
    if (url.pathname === "/api/git-stash-clear" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) {
        return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      }
      try {
        const resolvedCwd = resolve(cwd);
        execFileSync("git", ["stash", "clear"], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-stash-show?cwd=<path>&index=<n>
    if (url.pathname === "/api/git-stash-show" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const idx = url.searchParams.get("index");
      if (!cwd || idx === null) {
        return jsonResponse(req, res, { error: "Missing cwd or index" }, 400);
      }
      try {
        const resolvedCwd = resolve(cwd);
        const out = execFileSync(
          "git",
          ["stash", "show", "-p", `stash@{${parseInt(idx, 10)}}`],
          { cwd: resolvedCwd, encoding: "utf-8" },
        );
        return jsonResponse(req, res, { diff: out });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Git blame ────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/git-blame") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const algorithm = url.searchParams.get("algorithm") || "histogram";
      if (!cwd || !filePath) return jsonResponse(req, res, { error: "cwd and path required" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const out = spawnSync(GIT, ["blame", "--porcelain", `--diff-algorithm=${algorithm}`, "--", filePath],
          { cwd: resolvedCwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        const raw = out.stdout || "";
        const lines = raw.split("\n");
        const blameLines = [];
        let i = 0;
        while (i < lines.length) {
          const headerMatch = lines[i].match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
          if (!headerMatch) { i++; continue; }
          const hash = headerMatch[1];
          const origLine = parseInt(headerMatch[2], 10);
          const finalLine = parseInt(headerMatch[3], 10);
          i++;
          let author = "";
          let authorDate = "";
          let summary = "";
          while (i < lines.length && !lines[i].startsWith("\t")) {
            if (lines[i].startsWith("author ")) author = lines[i].slice(7);
            else if (lines[i].startsWith("author-time ")) authorDate = lines[i].slice(12);
            else if (lines[i].startsWith("summary ")) summary = lines[i].slice(8);
            i++;
          }
          const content = i < lines.length ? lines[i].slice(1) : "";
          i++;
          blameLines.push({ hash: hash.slice(0, 8), hashFull: hash, finalLine, origLine, author, authorDate, summary, content });
        }
        return jsonResponse(req, res, blameLines);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Git file log ───────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/git-file-log") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const count = parseInt(url.searchParams.get("count") || "50", 10);
      if (!cwd || !filePath) return jsonResponse(req, res, { error: "cwd and path required" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
        const out = spawnSync(GIT, ["log", "--follow", "-n", String(count), `--format=${fmt}`, "--", filePath],
          { cwd: resolvedCwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        return jsonResponse(req, res, parseFileLog(out.stdout || ""));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-file-log-pickaxe?cwd=&path=&search=&mode=S|G
    if (req.method === "GET" && url.pathname === "/api/git-file-log-pickaxe") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const search = url.searchParams.get("search") || "";
      const mode = url.searchParams.get("mode") === "G" ? "-G" : "-S";
      if (!cwd || !filePath || !search) return jsonResponse(req, res, { error: "cwd, path, search required" }, 400);
      try {
        const fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
        const out = spawnSync(GIT, ["log", "--follow", mode, search, `--format=${fmt}`, "--", filePath],
          { cwd: resolve(cwd), encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        return jsonResponse(req, res, parseFileLog(out.stdout || ""));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-file-log-range?cwd=&path=&startLine=&endLine=
    if (req.method === "GET" && url.pathname === "/api/git-file-log-range") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const startLine = url.searchParams.get("startLine") || "1";
      const endLine = url.searchParams.get("endLine") || "1";
      if (!cwd || !filePath) return jsonResponse(req, res, { error: "cwd and path required" }, 400);
      try {
        const fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
        const range = `${startLine},${endLine}:${filePath}`;
        const out = spawnSync(GIT, ["log", "-L", range, `--format=${fmt}`],
          { cwd: resolve(cwd), encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        return jsonResponse(req, res, parseFileLog(out.stdout || ""));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── GitHub REST API endpoints (no gh binary needed) ──────

    // POST /api/github-device-start — MOCK device flow (dev:web only).
    // Returns a static user code + verification URL. The frontend opens the URL
    // and starts polling; see /api/github-device-poll below.
    if (url.pathname === "/api/github-device-start" && req.method === "POST") {
      _mockGithubPolls = 0;
      // NOTE: verification_uri intentionally does NOT point at the real
      // github.com/login/device — this is a fake flow and a real code is never
      // issued. Sending the user to GitHub with a bogus code only confuses.
      return jsonResponse(req, res, {
        device_code: "mock-device-code",
        user_code: "DEV-MOCK",
        verification_uri: "about:blank#gitwand-dev-mock",
        verification_uri_complete: "",
        expires_in: 900,
        interval: 1,
      });
    }

    // POST /api/github-device-poll — MOCK: "pending" twice, then "success".
    // No real token is stored; this only unblocks UI iteration in dev:web.
    if (url.pathname === "/api/github-device-poll" && req.method === "POST") {
      _mockGithubPolls += 1;
      if (_mockGithubPolls < 3) {
        return jsonResponse(req, res, { status: "pending", login: "", error: "" });
      }
      return jsonResponse(req, res, { status: "success", login: "dev-user", error: "" });
    }

    // POST /api/github-token-present — MOCK: never "logged in" in dev:web.
    if (url.pathname === "/api/github-token-present" && req.method === "POST") {
      return jsonResponse(req, res, false);
    }

    // GET /api/gh-current-user — returns the authenticated GitHub login
    if (url.pathname === "/api/gh-current-user" && req.method === "GET") {
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token found. Run: gh auth login" }, 401);
        const resp = await githubFetch("/user", token);
        if (!resp.ok) {
          const text = await resp.text();
          return jsonResponse(req, res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
        }
        const data = await resp.json();
        return jsonResponse(req, res, data.login ?? "");
      } catch (err) {
        console.error("[gh-current-user]", err.message);
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-list-prs?cwd=<path>&state=<open|closed|all>
    if (url.pathname === "/api/gh-list-prs" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const state = url.searchParams.get("state") || "open";
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token found. Run: gh auth login" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo from git remote origin" }, 400);
        // Paginate up to 300 PRs (3 pages × 100)
        let raw = [];
        for (let page = 1; page <= 3; page++) {
          const resp = await githubFetch(`/repos/${nwo}/pulls?state=${state}&per_page=100&page=${page}`, token);
          if (!resp.ok) {
            const text = await resp.text();
            return jsonResponse(req, res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
          }
          const page_data = await resp.json();
          raw = raw.concat(page_data);
          if (page_data.length < 100) break; // last page
        }
        const prs = raw.map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login ?? "",
          branch: pr.head?.ref ?? "",
          base: pr.base?.ref ?? "",
          draft: pr.draft ?? false,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          url: pr.html_url,
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          labels: (pr.labels ?? []).map((l) => l.name),
          assignees: (pr.assignees ?? []).map((a) => a.login).filter(Boolean),
          review_requested: (pr.requested_reviewers ?? []).map((r) => r.login).filter(Boolean),
          // GitHub REST API /pulls does not expose reviewDecision (GraphQL-only via gh CLI).
          review_decision: "",
          // mergeable_state from list is null/unknown — filled in below via per-PR fetch.
          merge_state_status: "",
          // filled in below via check-runs API (parallel, one call per PR).
          checks_rollup: "",
          _head_sha: pr.head?.sha ?? "",
          _pr_number: pr.number,
        }));
        // Parallel enrichment: CI check-runs + per-PR mergeable_state.
        // The list endpoint returns mergeable_state null/unknown — need per-PR fetch.
        // Mirrors Rust rest_rollup_for_sha + rest_mergeable_state in github_api.rs.
        await Promise.all(prs.map(async (pr) => {
          const sha = pr._head_sha;
          const num = pr._pr_number;
          delete pr._head_sha;
          delete pr._pr_number;
          await Promise.all([
            // CI rollup
            (async () => {
              if (!sha) return;
              try {
                const r = await githubFetch(`/repos/${nwo}/commits/${sha}/check-runs?per_page=100`, token);
                if (!r.ok) return;
                const d = await r.json();
                const runs = d.check_runs ?? [];
                if (runs.length === 0) return;
                let pending = false;
                for (const run of runs) {
                  const outcome = (run.conclusion ?? "").toUpperCase();
                  if (["FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STALE"].includes(outcome)) {
                    pr.checks_rollup = "FAILURE"; return;
                  }
                  if (!["SUCCESS","NEUTRAL","SKIPPED"].includes(outcome)) pending = true;
                  if (run.status && run.status !== "completed" && !run.conclusion) pending = true;
                }
                pr.checks_rollup = pending ? "PENDING" : "SUCCESS";
              } catch { /* best-effort */ }
            })(),
            // Mergeable state (list returns null/unknown — fetch single PR)
            (async () => {
              if (!num) return;
              try {
                const r = await githubFetch(`/repos/${nwo}/pulls/${num}`, token);
                if (!r.ok) return;
                const d = await r.json();
                const state = (d.mergeable_state ?? "").toUpperCase();
                if (state && state !== "UNKNOWN") pr.merge_state_status = state;
              } catch { /* best-effort */ }
            })(),
          ]);
        }));
        return jsonResponse(req, res, prs);
      } catch (err) {
        console.error("[gh-list-prs]", err.message);
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-count?cwd=<path>&state=<open|closed|merged|all>
    // Lightweight counter — single REST call with `per_page=1` reading the
    // `Link: rel="last"` header to derive the total. Avoids fetching the
    // PR objects themselves (mirrors the Rust `gh_pr_count` which uses a
    // GraphQL totalCount edge).
    if (url.pathname === "/api/gh-pr-count" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const stateRaw = (url.searchParams.get("state") || "open").toLowerCase();
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      // REST API doesn't have a "merged" filter — merged PRs live under
      // state=closed with merged_at != null. For "merged" the count needs
      // a one-page scan; for now we map merged → closed (over-counts by
      // the # of closed-but-not-merged PRs, acceptable for the dashboard
      // hint). TODO Phase 2: tighten via /search?q=is:merged.
      const state =
        stateRaw === "merged" ? "closed" :
        stateRaw === "all" ? "all" :
        stateRaw === "closed" ? "closed" : "open";
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, 0);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, 0);
        const resp = await githubFetch(`/repos/${nwo}/pulls?state=${state}&per_page=1`, token);
        if (!resp.ok) return jsonResponse(req, res, 0);
        const linkHeader = resp.headers.get("link") || "";
        // Parse `<...&page=N>; rel="last"` to extract the total page count
        // (which equals total items when per_page=1).
        const m = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
        if (m) return jsonResponse(req, res, parseInt(m[1], 10));
        // No Link header → fewer than per_page items on the first page;
        // count what we got.
        const data = await resp.json();
        return jsonResponse(req, res, Array.isArray(data) ? data.length : 0);
      } catch (err) {
        console.error("[gh-pr-count]", err.message);
        return jsonResponse(req, res, 0);
      }
    }

    // POST /api/gh-create-pr
    // Body: { cwd, title, body, base?, head?, draft?, reviewers? }
    // Creates the PR via REST, then requests reviewers in a second call
    // (GitHub requires a POST to /requested_reviewers after creation).
    if (url.pathname === "/api/gh-create-pr" && req.method === "POST") {
      const payload = await readBody(req);
      const { cwd, title, body: prBody, base, head, draft, reviewers } = payload;
      if (!cwd || !title) return jsonResponse(req, res, { error: "Missing cwd or title" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token found. Run: gh auth login" }, 401);
        const repoCwd = resolve(cwd);
        const nwo = getRepoNwo(repoCwd);
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo from git remote origin" }, 400);

        // Resolve head: default to current branch (git symbolic-ref HEAD)
        let headBranch = (head ?? "").trim();
        if (!headBranch) {
          const r = spawnSync(GIT, ["symbolic-ref", "--short", "HEAD"], { cwd: repoCwd, encoding: "utf-8" });
          if (r.status !== 0) return jsonResponse(req, res, { error: "Could not determine current branch" }, 500);
          headBranch = r.stdout.trim();
        }
        if (!headBranch) return jsonResponse(req, res, { error: "Empty head branch" }, 400);

        // Resolve base: explicit → repo's default branch on GitHub
        let baseBranch = (base ?? "").trim();
        if (!baseBranch) {
          const repoResp = await githubFetch(`/repos/${nwo}`, token);
          if (repoResp.ok) {
            const info = await repoResp.json();
            baseBranch = info.default_branch ?? "main";
          } else {
            baseBranch = "main";
          }
        }

        if (baseBranch === headBranch) {
          return jsonResponse(req, res, { error: `Base and head branches are the same (${headBranch})` }, 400);
        }

        // Create the PR
        const createResp = await fetch(`https://api.github.com/repos/${nwo}/pulls`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            title,
            body: prBody ?? "",
            base: baseBranch,
            head: headBranch,
            draft: draft === true,
          }),
        });
        if (!createResp.ok) {
          const text = await createResp.text();
          return jsonResponse(req, res, { error: `GitHub API ${createResp.status}: ${text}` }, 500);
        }
        const pr = await createResp.json();

        // Request reviewers (user logins and org/team-slug supported)
        const cleaned = Array.isArray(reviewers)
          ? reviewers.map((r) => String(r).trim().replace(/^@/, "")).filter(Boolean)
          : [];
        if (cleaned.length > 0) {
          const users = cleaned.filter((r) => !r.includes("/"));
          const teams = cleaned
            .filter((r) => r.includes("/"))
            .map((r) => r.split("/", 2)[1])
            .filter(Boolean);
          try {
            const rvResp = await fetch(
              `https://api.github.com/repos/${nwo}/pulls/${pr.number}/requested_reviewers`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: "application/vnd.github+json",
                  "Content-Type": "application/json",
                  "X-GitHub-Api-Version": "2022-11-28",
                },
                body: JSON.stringify({ reviewers: users, team_reviewers: teams }),
              },
            );
            if (!rvResp.ok) {
              // PR was created — log the reviewer failure but don't surface it as a hard error.
              const text = await rvResp.text();
              console.warn(`[gh-create-pr] reviewers request failed: ${rvResp.status} ${text}`);
            }
          } catch (rvErr) {
            console.warn("[gh-create-pr] reviewers request threw:", rvErr.message);
          }
        }

        return jsonResponse(req, res, {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login ?? "",
          branch: pr.head?.ref ?? headBranch,
          base: pr.base?.ref ?? baseBranch,
          draft: pr.draft ?? false,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          url: pr.html_url,
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          labels: (pr.labels ?? []).map((l) => l.name),
        });
      } catch (err) {
        console.error("[gh-create-pr]", err.message);
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-reviewer-candidates?cwd=<path>
    // Lists assignees (users with push access) for autocomplete.
    if (url.pathname === "/api/gh-reviewer-candidates" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        // Paginate up to 3 pages of 100 = 300 candidates.
        const all = [];
        const seen = new Set();
        for (let page = 1; page <= 3; page++) {
          const resp = await githubFetch(`/repos/${nwo}/assignees?per_page=100&page=${page}`, token);
          if (!resp.ok) break;
          const raw = await resp.json();
          if (!Array.isArray(raw) || raw.length === 0) break;
          for (const u of raw) {
            if (!u.login || seen.has(u.login)) continue;
            seen.add(u.login);
            all.push({
              login: u.login,
              name: u.name ?? null,
              avatar_url: u.avatar_url ?? null,
            });
          }
          if (raw.length < 100) break;
        }
        all.sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
        return jsonResponse(req, res, all);
      } catch (err) {
        console.error("[gh-reviewer-candidates]", err.message);
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-detail?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-detail" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const pr = await resp.json();
        return jsonResponse(req, res, {
          number: pr.number,
          title: pr.title,
          body: pr.body ?? "",
          state: pr.state,
          author: pr.user?.login ?? "",
          branch: pr.head?.ref ?? "",
          base: pr.base?.ref ?? "",
          draft: pr.draft ?? false,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          merged_at: pr.merged_at ?? "",
          url: pr.html_url,
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          changed_files: pr.changed_files ?? 0,
          comments: pr.comments ?? 0,
          review_comments: pr.review_comments ?? 0,
          labels: (pr.labels ?? []).map((l) => l.name),
          reviewers: (pr.requested_reviewers ?? []).map((r) => r.login ?? ""),
          mergeable: pr.mergeable_state ?? "unknown",
          checks_status: "",
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-diff?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token, "application/vnd.github.v3.diff");
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const diff = await resp.text();
        return jsonResponse(req, res, { diff });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-checks?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-checks" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        // Get PR head SHA first
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(req, res, { error: `GitHub API ${prResp.status}` }, 500);
        const pr = await prResp.json();
        const sha = pr.head?.sha;
        if (!sha) return jsonResponse(req, res, []);
        // Get check runs for that commit
        const checksResp = await githubFetch(`/repos/${nwo}/commits/${sha}/check-runs?per_page=100`, token);
        if (!checksResp.ok) return jsonResponse(req, res, { error: `GitHub API ${checksResp.status}` }, 500);
        const data = await checksResp.json();
        return jsonResponse(req, res, (data.check_runs ?? []).map((c) => ({
          name: c.name,
          state: c.status === "completed" ? c.conclusion : c.status,
          conclusion: c.conclusion ?? "",
          details_url: c.html_url ?? "",
        })));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-check-annotations?cwd=<path>&number=<n>  (v2.18)
    if (url.pathname === "/api/gh-check-annotations" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        // PR head SHA
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(req, res, { error: `GitHub API ${prResp.status}` }, 500);
        const pr = await prResp.json();
        const sha = pr.head?.sha;
        if (!sha) return jsonResponse(req, res, []);
        // Check runs with annotation counts
        const checksResp = await githubFetch(`/repos/${nwo}/commits/${sha}/check-runs?per_page=100`, token);
        if (!checksResp.ok) return jsonResponse(req, res, { error: `GitHub API ${checksResp.status}` }, 500);
        const data = await checksResp.json();
        const annotated = (data.check_runs ?? [])
          .filter((c) => (c.output?.annotations_count ?? 0) > 0)
          .slice(0, 20); // mirror the Rust MAX_ANNOTATED_RUNS cap
        const annotations = [];
        for (const run of annotated) {
          const annResp = await githubFetch(`/repos/${nwo}/check-runs/${run.id}/annotations?per_page=100`, token);
          if (!annResp.ok) continue; // annotations expired — skip run
          const items = await annResp.json();
          for (const a of items ?? []) {
            annotations.push({
              check_name: run.name ?? "",
              path: a.path ?? "",
              start_line: a.start_line ?? 0,
              end_line: Math.max(a.end_line ?? 0, a.start_line ?? 0),
              level: a.annotation_level === "failure" || a.annotation_level === "warning"
                ? a.annotation_level : "notice",
              title: a.title ?? "",
              message: a.message ?? "",
            });
          }
        }
        return jsonResponse(req, res, annotations);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── PR Review Comments ────────────────────────────────

    // GET /api/gh-pr-comments?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-comments" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = await resolvePrNwo(resolve(cwd), number, token);
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        // Fetch all review comments (paginated — up to 200)
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}/comments?per_page=100`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const raw = await resp.json();
        return jsonResponse(req, res, raw.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user?.login ?? "",
          created_at: c.created_at,
          updated_at: c.updated_at,
          path: c.path,
          line: c.line ?? null,
          original_line: c.original_line ?? null,
          side: c.side ?? "RIGHT",
          start_line: c.start_line ?? null,
          start_side: c.start_side ?? null,
          in_reply_to_id: c.in_reply_to_id ?? null,
          diff_hunk: c.diff_hunk ?? "",
          url: c.html_url ?? "",
        })));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-issue-comments?cwd=<path>&number=<n>
    // Issue-level (conversation) comments — not anchored to a diff line.
    if (url.pathname === "/api/gh-pr-issue-comments" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = await resolvePrNwo(resolve(cwd), number, token);
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/issues/${number}/comments?per_page=100`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const raw = await resp.json();
        return jsonResponse(req, res, raw.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user?.login ?? "",
          created_at: c.created_at,
          updated_at: c.updated_at,
          path: "",
          line: null,
          original_line: null,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          in_reply_to_id: null,
          diff_hunk: "",
          url: c.html_url ?? "",
        })));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Issues (detail / comments / comment / state) ─────────────────────
    // GET /api/gh-issue-detail?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-issue-detail" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/issues/${number}`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const i = await resp.json();
        return jsonResponse(req, res, {
          number: i.number,
          title: i.title,
          body: i.body ?? "",
          state: i.state,
          author: i.user?.login ?? "",
          assignees: (i.assignees ?? []).map((a) => a.login),
          labels: (i.labels ?? []).map((l) => l.name),
          url: i.html_url ?? "",
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          milestone: i.milestone?.title ?? "",
          comments: i.comments ?? 0,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-issue-comments?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-issue-comments" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/issues/${number}/comments?per_page=100`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const raw = await resp.json();
        return jsonResponse(req, res, raw.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user?.login ?? "",
          created_at: c.created_at,
          updated_at: c.updated_at,
          url: c.html_url ?? "",
        })));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/gh-issue-comment  { cwd, number, body }
    if (url.pathname === "/api/gh-issue-comment" && req.method === "POST") {
      const body = await readBody(req);
      const { cwd, number, body: commentBody } = body;
      if (!cwd || !number || !commentBody) return jsonResponse(req, res, { error: "Missing required fields" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await fetch(`https://api.github.com/repos/${nwo}/issues/${number}/comments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ body: commentBody }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          return jsonResponse(req, res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
        }
        const c = await resp.json();
        return jsonResponse(req, res, {
          id: c.id, body: c.body, author: c.user?.login ?? "",
          created_at: c.created_at, updated_at: c.updated_at, url: c.html_url ?? "",
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/gh-issue-state  { cwd, number, state }  (state = "closed" | "open")
    if (url.pathname === "/api/gh-issue-state" && req.method === "POST") {
      const body = await readBody(req);
      const { cwd, number, state } = body;
      if (!cwd || !number || !state) return jsonResponse(req, res, { error: "Missing required fields" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await fetch(`https://api.github.com/repos/${nwo}/issues/${number}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ state }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          return jsonResponse(req, res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/gh-pr-comment  — create or reply
    // Body: { cwd, number, body, path, line, side, start_line?, start_side?, in_reply_to_id? }
    if (url.pathname === "/api/gh-pr-comment" && req.method === "POST") {
      const body = await readBody(req);
      const { cwd, number, body: commentBody, path: filePath, line, side, start_line, start_side, in_reply_to_id } = body;
      if (!cwd || !number || !commentBody) return jsonResponse(req, res, { error: "Missing required fields" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        // Get PR head commit SHA
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(req, res, { error: `GitHub API ${prResp.status}` }, 500);
        const pr = await prResp.json();
        const commit_id = pr.head?.sha;
        const payload = in_reply_to_id
          ? { body: commentBody, in_reply_to_id }
          : { body: commentBody, commit_id, path: filePath, line: line ?? 1, side: side ?? "RIGHT",
              ...(start_line ? { start_line, start_side: start_side ?? "RIGHT" } : {}) };
        const resp = await fetch(`https://api.github.com/repos/${nwo}/pulls/${number}/comments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const text = await resp.text();
          return jsonResponse(req, res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
        }
        const c = await resp.json();
        return jsonResponse(req, res, {
          id: c.id, body: c.body, author: c.user?.login ?? "",
          created_at: c.created_at, updated_at: c.updated_at,
          path: c.path, line: c.line ?? null, original_line: c.original_line ?? null,
          side: c.side ?? "RIGHT", start_line: c.start_line ?? null, start_side: c.start_side ?? null,
          in_reply_to_id: c.in_reply_to_id ?? null, diff_hunk: c.diff_hunk ?? "", url: c.html_url ?? "",
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // PATCH /api/gh-pr-comment?id=<n>  — edit comment body
    // Body: { cwd, body }
    if (url.pathname === "/api/gh-pr-comment" && req.method === "PATCH") {
      const id = url.searchParams.get("id");
      const body = await readBody(req);
      const { cwd, body: newBody } = body;
      if (!id || !cwd || !newBody) return jsonResponse(req, res, { error: "Missing id, cwd or body" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await fetch(`https://api.github.com/repos/${nwo}/pulls/comments/${id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ body: newBody }),
        });
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const c = await resp.json();
        return jsonResponse(req, res, { id: c.id, body: c.body, updated_at: c.updated_at });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // DELETE /api/gh-pr-comment?cwd=<path>&id=<n>
    if (url.pathname === "/api/gh-pr-comment" && req.method === "DELETE") {
      const cwd = url.searchParams.get("cwd");
      const id = url.searchParams.get("id");
      if (!cwd || !id) return jsonResponse(req, res, { error: "Missing cwd or id" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await fetch(`https://api.github.com/repos/${nwo}/pulls/comments/${id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!resp.ok && resp.status !== 204) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── PR Reviews ────────────────────────────────────────

    // GET /api/gh-pr-reviews?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-reviews" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = await resolvePrNwo(resolve(cwd), number, token);
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}/reviews?per_page=100`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const raw = await resp.json();
        // Map to the frontend `PrReview` shape (parity with the Tauri
        // `map_reviews`), instead of leaking the raw GitHub object.
        return jsonResponse(req, res, raw.map((r) => ({
          id: r.id,
          state: r.state,
          body: r.body ?? "",
          user: { login: r.user?.login ?? "", avatar_url: r.user?.avatar_url ?? "" },
          submitted_at: r.submitted_at,
          html_url: r.html_url,
        })));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/gh-pr-submit-review
    // Body: { cwd, number, event, body, comments? }
    // event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
    // comments: [{ path, line, side, start_line?, start_side?, body }]
    if (url.pathname === "/api/gh-pr-submit-review" && req.method === "POST") {
      const body = await readBody(req);
      const { cwd, number, event: reviewEvent, body: reviewBody, comments = [] } = body;
      if (!cwd || !number || !reviewEvent) return jsonResponse(req, res, { error: "Missing cwd, number, or event" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);

        // Get PR head SHA (required by GitHub API)
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(req, res, { error: `GitHub API ${prResp.status}` }, 500);
        const pr = await prResp.json();
        const commitId = pr.head.sha;

        const payload = { commit_id: commitId, event: reviewEvent };
        if (reviewBody) payload.body = reviewBody;
        if (comments.length > 0) payload.comments = comments;

        const resp = await fetch(`https://api.github.com/repos/${nwo}/pulls/${number}/reviews`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          console.warn("[gh-pr-submit-review] GitHub error", resp.status, errBody);
          // GitHub's 422 body for reviews uses two shapes:
          //   { message: "...", errors: ["Can not approve your own pull request"] }   ← array of strings
          //   { message: "...", errors: [{ message: "...", code: "..." }] }           ← array of objects
          // Handle both and fall back to stringifying the body.
          let detail = "";
          if (Array.isArray(errBody.errors) && errBody.errors.length > 0) {
            const first = errBody.errors[0];
            const text = typeof first === "string" ? first : (first?.message || first?.code || JSON.stringify(first));
            if (text) detail = ` — ${text}`;
          }
          const message = `${errBody.message || `GitHub API ${resp.status}`}${detail}`;
          return jsonResponse(req, res, { error: message }, resp.status);
        }
        const review = await resp.json();
        return jsonResponse(req, res, review);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Phase 9.4 Intelligence ────────────────────────────

    // GET /api/gh-pr-conflict-preview?cwd=<path>&number=<n>
    // Fetches PR head via git fetch, then runs git merge-tree to detect conflicts
    // without touching the working tree.
    if (url.pathname === "/api/gh-pr-conflict-preview" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);

        // Get PR base branch + head SHA from GitHub API
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(req, res, { error: `GitHub API ${prResp.status}` }, 500);
        const pr = await prResp.json();
        const baseBranch = pr.base.ref;
        const headSha = pr.head.sha;
        const absPath = resolve(cwd);

        // Fetch PR head ref so we have it locally
        const fetchRes = spawnSync(GIT, ["fetch", "--quiet", "origin", `refs/pull/${number}/head:refs/pr/${number}`], {
          cwd: absPath, encoding: "utf-8",
        });
        // If fetch fails (e.g., no network access to remote), fall back to using headSha directly
        const prRef = fetchRes.status === 0 ? `refs/pr/${number}` : headSha;

        // Fetch base branch too (may already be current)
        spawnSync(GIT, ["fetch", "--quiet", "origin", baseBranch], { cwd: absPath, encoding: "utf-8" });
        const baseRef = `origin/${baseBranch}`;

        // Find merge base
        const mbRes = spawnSync(GIT, ["merge-base", baseRef, prRef], { cwd: absPath, encoding: "utf-8" });
        if (mbRes.status !== 0) return jsonResponse(req, res, { error: "Cannot find merge-base" }, 500);
        const mergeBase = mbRes.stdout.trim();

        // Run git merge-tree (read-only)
        const mtRes = spawnSync(GIT, ["merge-tree", mergeBase, baseRef, prRef], { cwd: absPath, encoding: "utf-8" });
        const output = mtRes.stdout || "";

        // Parse output: lines starting with "changed in both" or conflict markers
        const conflicting = [];
        const clean = [];
        let currentFile = null;
        let conflictCount = 0;
        let isConflict = false;

        for (const line of output.split("\n")) {
          if (line.startsWith("changed in both")) {
            isConflict = true;
            continue;
          }
          if (isConflict && line.startsWith("  base")) { isConflict = false; continue; }
          // Detect file paths in merge-tree output (lines like "  result <oid> <mode>\t<path>")
          const fileMatch = line.match(/^added in (?:local|remote)|^removed in (?:local|remote)|^\+{7}|^={7}|^<{7}|^>{7}/);
          if (fileMatch && currentFile) conflictCount++;

          // Check for +++ markers (conflict content)
          if (line.startsWith("+<<<<<<< ") || line.startsWith("<<<<<<< ")) {
            if (currentFile) conflictCount++;
          }
        }

        // Simpler approach: use git-diff to find what merge-tree would conflict on
        // Use GitHub API mergeability instead of parsing merge-tree output (more reliable)
        const mergeability = pr.mergeable;
        const mergeState = pr.mergeable_state;

        // Get the list of files changed in this PR
        const prFilesResp = await githubFetch(`/repos/${nwo}/pulls/${number}/files?per_page=100`, token);
        const prFiles = prFilesResp.ok ? await prFilesResp.json() : [];

        // For each file, check if it also has local changes on base (potential conflict)
        // Run git diff between merge-base and base to find overlapping files
        const baseDiffRes = spawnSync(GIT, ["diff", "--name-only", mergeBase, baseRef], {
          cwd: absPath, encoding: "utf-8",
        });
        const prDiffRes = spawnSync(GIT, ["diff", "--name-only", mergeBase, prRef], {
          cwd: absPath, encoding: "utf-8",
        });

        const baseChangedFiles = new Set((baseDiffRes.stdout || "").trim().split("\n").filter(Boolean));
        const prChangedFiles = new Set((prDiffRes.stdout || "").trim().split("\n").filter(Boolean));

        const overlapping = [...prChangedFiles].filter((f) => baseChangedFiles.has(f));
        const nonOverlapping = [...prChangedFiles].filter((f) => !baseChangedFiles.has(f));

        // If GitHub says CONFLICTING, the overlapping files are the likely conflicts
        const isConflicting = mergeability === false || mergeState === "dirty" || mergeState === "blocked";
        const conflictingFiles = isConflicting ? overlapping : [];

        return jsonResponse(req, res, {
          mergeable: mergeability,
          mergeableState: mergeState,
          conflictingFiles,
          cleanFiles: isConflicting ? nonOverlapping : [...prChangedFiles],
          overlappingFiles: overlapping,
          totalPrFiles: prFiles.length,
          summary: isConflicting
            ? `⚠️ ${conflictingFiles.length} fichier(s) en conflit probable`
            : `✅ Pas de conflit détecté`,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-hotspots?cwd=<path>&paths=file1,file2,...
    // For each file path, count merge commits that touched it — "conflict hotspot" score.
    if (url.pathname === "/api/gh-pr-hotspots" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const pathsParam = url.searchParams.get("paths");
      if (!cwd || !pathsParam) return jsonResponse(req, res, { error: "Missing cwd or paths" }, 400);
      try {
        const absPath = resolve(cwd);
        const paths = pathsParam.split(",").filter(Boolean);
        const hotspots = paths.map((filePath) => {
          // Count merge commits that touched this file
          const mergeLogRes = spawnSync(
            GIT,
            ["log", "--merges", "--oneline", "--", filePath],
            { cwd: absPath, encoding: "utf-8" },
          );
          const mergeCommits = (mergeLogRes.stdout || "").trim().split("\n").filter(Boolean);
          // Also count total commits touching this file
          const totalLogRes = spawnSync(
            GIT,
            ["log", "--oneline", "--", filePath],
            { cwd: absPath, encoding: "utf-8" },
          );
          const totalCommits = (totalLogRes.stdout || "").trim().split("\n").filter(Boolean);
          // Last commit that touched this file
          const lastCommitRes = spawnSync(
            GIT,
            ["log", "-1", "--format=%h %s", "--", filePath],
            { cwd: absPath, encoding: "utf-8" },
          );
          return {
            path: filePath,
            mergeCount: mergeCommits.length,
            totalCount: totalCommits.length,
            // Hotspot score: merge commits / total commits (files that are always involved in merges)
            score: totalCommits.length > 0 ? Math.round((mergeCommits.length / totalCommits.length) * 100) : 0,
            lastChange: lastCommitRes.stdout.trim(),
          };
        });
        return jsonResponse(req, res, hotspots);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-file-count?cwd=<path>
    // Returns total number of tracked files in the repo.
    if (url.pathname === "/api/git-file-count" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const r = spawnSync(GIT, ["ls-files", "--cached"], { cwd: resolve(cwd), encoding: "utf-8" });
        const count = (r.stdout || "").trim().split("\n").filter(Boolean).length;
        return jsonResponse(req, res, { count });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-pr-file-history?cwd=<path>&paths=file1,file2,...
    // For each file, fetch the last 3 closed PRs that touched it + their review comments.
    if (url.pathname === "/api/gh-pr-file-history" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const pathsParam = url.searchParams.get("paths");
      if (!cwd || !pathsParam) return jsonResponse(req, res, { error: "Missing cwd or paths" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const paths = pathsParam.split(",").filter(Boolean);

        // Get all review comments (last 100) and filter by path
        const commentsResp = await githubFetch(
          `/repos/${nwo}/pulls/comments?per_page=100&sort=updated&direction=desc`,
          token,
        );
        const allComments = commentsResp.ok ? await commentsResp.json() : [];

        const result = {};
        for (const filePath of paths) {
          const fileComments = allComments.filter((c) => c.path === filePath);
          // Unique reviewers
          const reviewers = [...new Set(fileComments.map((c) => c.user?.login).filter(Boolean))];
          result[filePath] = {
            reviewCommentCount: fileComments.length,
            reviewers,
            // Most recent comment
            lastComment: fileComments[0]
              ? { author: fileComments[0].user?.login, body: fileComments[0].body?.slice(0, 80), pr_number: fileComments[0].pull_request_url?.match(/\/(\d+)$/)?.[1] }
              : null,
          };
        }
        return jsonResponse(req, res, result);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Claude Code CLI (dev mirror) ─────────────────────
    //
    // When spawning the `claude` binary, we strip API-key env vars (see
    // `claudeSpawnEnv` at module scope) so the CLI uses the user's OAuth
    // subscription instead of a stale key that may be lying around in
    // their shell. Matches the Rust backend.

    //
    // Wraps the user's locally-installed `claude` binary so GitWand can
    // piggyback on their Claude Max/Pro subscription without implementing
    // OAuth. Mirrors the Rust commands `detect_claude_cli`, `claude_cli_prompt`
    // and `claude_cli_login`.

    // GET /api/claude-cli-detect
    if (url.pathname === "/api/claude-cli-detect" && req.method === "GET") {
      try {
        const CLAUDE = resolveBin("claude");
        // `resolveBin` falls back to the bare name on PATH; if nothing
        // matches, we consider it not found.
        const exists = (() => {
          try {
            return existsSync(CLAUDE);
          } catch { return false; }
        })();

        // Also try explicit PATH lookup via `which`.
        let resolved = exists ? CLAUDE : "";
        if (!resolved) {
          try {
            const r = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf-8" });
            if (r.status === 0 && r.stdout.trim()) {
              resolved = r.stdout.split(/\r?\n/)[0].trim();
            }
          } catch { /* ignore */ }
        }

        if (!resolved) {
          return jsonResponse(req, res, {
            found: false,
            path: "",
            version: "",
            logged_in: false,
            status: "not_found",
            detail: "Binaire `claude` introuvable. Installez-le avec `npm install -g @anthropic-ai/claude-code`.",
          });
        }

        let version = "";
        try {
          const r = spawnSync(resolved, ["--version"], { encoding: "utf-8" });
          if (r.status === 0) version = r.stdout.trim();
        } catch { /* ignore */ }

        // Ping to check auth.
        let loggedIn = false;
        let status = "error";
        let detail = "";
        try {
          const r = spawnSync(resolved, ["-p", "ping", "--output-format", "text"], { encoding: "utf-8", env: claudeSpawnEnv });
          if (r.status === 0) {
            loggedIn = true;
            status = "ok";
          } else {
            const combined = (r.stderr || r.stdout || "").trim();
            const lower = combined.toLowerCase();
            const authy = lower.includes("login") || lower.includes("authenticat") || lower.includes("unauthor") || lower.includes("api key");
            status = authy ? "not_logged_in" : "error";
            detail = combined;
          }
        } catch (err) {
          detail = `Impossible d'exécuter claude: ${err.message}`;
        }

        return jsonResponse(req, res, {
          found: true,
          path: resolved,
          version,
          logged_in: loggedIn,
          status,
          detail,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/claude-cli-prompt  { prompt, systemPrompt?, cwd?, outputFormat?, model? }
    if (url.pathname === "/api/claude-cli-prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const CLAUDE = resolveBin("claude");
        const fullPrompt = body.systemPrompt && body.systemPrompt.trim()
          ? `# System\n${body.systemPrompt.trim()}\n\n# User\n${(body.prompt || "").trim()}`
          : (body.prompt || "");
        const fmt = body.outputFormat || "text";
        // v2.17 — explicit per-provider model selection.
        const claudeArgs = ["-p", fullPrompt, "--output-format", fmt];
        if (body.model && String(body.model).trim()) {
          claudeArgs.push("--model", String(body.model).trim());
        }
        const r = spawnSync(CLAUDE, claudeArgs, {
          cwd: body.cwd || undefined,
          encoding: "utf-8",
          maxBuffer: 20 * 1024 * 1024,
          env: claudeSpawnEnv,
        });
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "Claude CLI a échoué sans message";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return res.writeHead(200, { ...corsHeaders(req), "Content-Type": "text/plain" }).end(r.stdout);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Codex CLI provider (v2.0) ─────────────────────────
    // GET /api/codex-cli-detect
    if (url.pathname === "/api/codex-cli-detect" && req.method === "GET") {
      try {
        const CODEX = resolveBin("codex");
        const exists = (() => {
          try { return existsSync(CODEX); } catch { return false; }
        })();
        let resolved = exists ? CODEX : "";
        if (!resolved) {
          try {
            const r = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf-8" });
            if (r.status === 0 && r.stdout.trim()) {
              resolved = r.stdout.split(/\r?\n/)[0].trim();
            }
          } catch { /* ignore */ }
        }

        if (!resolved) {
          return jsonResponse(req, res, {
            found: false,
            path: "",
            version: "",
            logged_in: false,
            status: "not_found",
            detail: "Binaire `codex` introuvable. Installez-le avec `npm install -g @openai/codex`.",
          });
        }

        let version = "";
        try {
          const r = spawnSync(resolved, ["--version"], { encoding: "utf-8" });
          if (r.status === 0) version = r.stdout.trim();
        } catch { /* ignore */ }

        let loggedIn = false;
        let status = "error";
        let detail = "";
        try {
          const r = spawnSync(resolved, ["exec", "ping"], { encoding: "utf-8" });
          if (r.status === 0) {
            loggedIn = true;
            status = "ok";
          } else {
            const combined = (r.stderr || r.stdout || "").trim();
            const lower = combined.toLowerCase();
            const authy = lower.includes("login") || lower.includes("authenticat") || lower.includes("unauthor") || lower.includes("api key") || lower.includes("openai_api_key");
            status = authy ? "not_logged_in" : "error";
            detail = combined;
          }
        } catch (err) {
          detail = `Impossible d'exécuter codex: ${err.message}`;
        }

        return jsonResponse(req, res, {
          found: true,
          path: resolved,
          version,
          logged_in: loggedIn,
          status,
          detail,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/codex-cli-prompt  { prompt, systemPrompt?, cwd?, model? }
    if (url.pathname === "/api/codex-cli-prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const CODEX = resolveBin("codex");
        const fullPrompt = body.systemPrompt && body.systemPrompt.trim()
          ? `# System\n${body.systemPrompt.trim()}\n\n# User\n${(body.prompt || "").trim()}`
          : (body.prompt || "");
        // v2.17 — model flag precedes the positional prompt on `codex exec`.
        const codexArgs = ["exec"];
        if (body.model && String(body.model).trim()) {
          codexArgs.push("--model", String(body.model).trim());
        }
        codexArgs.push(fullPrompt);
        const r = spawnSync(CODEX, codexArgs, {
          cwd: body.cwd || undefined,
          encoding: "utf-8",
          maxBuffer: 20 * 1024 * 1024,
        });
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "Codex CLI a échoué sans message";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return res.writeHead(200, { ...corsHeaders(req), "Content-Type": "text/plain" }).end(r.stdout);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── opencode CLI provider (v2.17) ─────────────────────
    // GET /api/opencode-cli-detect
    if (url.pathname === "/api/opencode-cli-detect" && req.method === "GET") {
      try {
        const OPENCODE = resolveBin("opencode");
        const exists = (() => {
          try { return existsSync(OPENCODE); } catch { return false; }
        })();
        let resolved = exists ? OPENCODE : "";
        if (!resolved) {
          try {
            const r = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf-8" });
            if (r.status === 0 && r.stdout.trim()) {
              resolved = r.stdout.split(/\r?\n/)[0].trim();
            }
          } catch { /* ignore */ }
        }

        if (!resolved) {
          return jsonResponse(req, res, {
            found: false,
            path: "",
            version: "",
            logged_in: false,
            status: "not_found",
            detail: "Binaire `opencode` introuvable. Installez-le avec `npm install -g opencode-ai` ou `curl -fsSL https://opencode.ai/install | bash`.",
          });
        }

        let version = "";
        try {
          const r = spawnSync(resolved, ["--version"], { encoding: "utf-8" });
          if (r.status === 0) version = r.stdout.trim();
        } catch { /* ignore */ }

        return jsonResponse(req, res, {
          found: true,
          path: resolved,
          version,
          logged_in: false,
          status: "detected",
          detail: "",
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/opencode-cli-prompt  { prompt, systemPrompt?, cwd?, model? }
    if (url.pathname === "/api/opencode-cli-prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const OPENCODE = resolveBin("opencode");
        const fullPrompt = body.systemPrompt && body.systemPrompt.trim()
          ? `# System\n${body.systemPrompt.trim()}\n\n# User\n${(body.prompt || "").trim()}`
          : (body.prompt || "");
        const ocArgs = ["run"];
        if (body.model && String(body.model).trim()) {
          ocArgs.push("--model", String(body.model).trim());
        }
        ocArgs.push(fullPrompt);
        const r = spawnSync(OPENCODE, ocArgs, {
          cwd: body.cwd || undefined,
          encoding: "utf-8",
          maxBuffer: 20 * 1024 * 1024,
        });
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "opencode CLI a échoué sans message";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return res.writeHead(200, { ...corsHeaders(req), "Content-Type": "text/plain" }).end(r.stdout);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/opencode-models  → { models: string[] }
    if (url.pathname === "/api/opencode-models" && req.method === "GET") {
      try {
        const OPENCODE = resolveBin("opencode");
        const r = spawnSync(OPENCODE, ["models"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
        if (r.status !== 0) {
          return jsonResponse(req, res, { models: [] });
        }
        const models = (r.stdout || "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && l.includes("/"));
        return jsonResponse(req, res, { models });
      } catch {
        return jsonResponse(req, res, { models: [] });
      }
    }

    // GET /api/copilot-cli-detect
    if (url.pathname === "/api/copilot-cli-detect" && req.method === "GET") {
      try {
        const COPILOT = resolveBin("copilot");
        const exists = (() => {
          try { return existsSync(COPILOT); } catch { return false; }
        })();
        let resolved = exists ? COPILOT : "";
        if (!resolved) {
          try {
            const r = spawnSync(process.platform === "win32" ? "where" : "which", ["copilot"], { encoding: "utf-8" });
            if (r.status === 0 && r.stdout.trim()) {
              resolved = r.stdout.split(/\r?\n/)[0].trim();
            }
          } catch { /* ignore */ }
        }

        if (!resolved) {
          return jsonResponse(req, res, {
            found: false,
            path: "",
            version: "",
            logged_in: false,
            status: "not_found",
            detail: "Binaire `copilot` introuvable. Installez-le avec `npm install -g @github/copilot`.",
          });
        }

        let version = "";
        try {
          const r = spawnSync(resolved, ["--version"], { encoding: "utf-8" });
          if (r.status === 0) version = r.stdout.trim();
        } catch { /* ignore */ }

        return jsonResponse(req, res, {
          found: true,
          path: resolved,
          version,
          logged_in: false,
          status: "detected",
          detail: "",
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/copilot-cli-prompt  { prompt, systemPrompt?, cwd?, model? }
    if (url.pathname === "/api/copilot-cli-prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const COPILOT = resolveBin("copilot");
        const fullPrompt = body.systemPrompt && body.systemPrompt.trim()
          ? `# System\n${body.systemPrompt.trim()}\n\n# User\n${(body.prompt || "").trim()}`
          : (body.prompt || "");
        const cpArgs = ["--no-color", "--deny-tool=shell", "--deny-tool=write", "--no-ask-user"];
        if (body.model && String(body.model).trim()) {
          cpArgs.push("--model", String(body.model).trim());
        }
        cpArgs.push("-p", fullPrompt);
        const cpEnv = { ...process.env };
        delete cpEnv.COPILOT_ALLOW_ALL;
        const r = spawnSync(COPILOT, cpArgs, {
          cwd: body.cwd || undefined,
          env: cpEnv,
          encoding: "utf-8",
          timeout: 5 * 60 * 1000,
          maxBuffer: 20 * 1024 * 1024,
        });
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "Copilot CLI a échoué sans message";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return res.writeHead(200, { ...corsHeaders(req), "Content-Type": "text/plain" }).end(r.stdout);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/claude-cli-login  (opens a terminal with `claude login`)
    if (url.pathname === "/api/claude-cli-login" && req.method === "POST") {
      try {
        const CLAUDE = resolveBin("claude");
        if (process.platform === "darwin") {
          const script = `tell application "Terminal" to do script "${CLAUDE.replace(/"/g, '\\"')} login"`;
          spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
        } else if (process.platform === "win32") {
          spawn("cmd", ["/c", "start", "cmd", "/k", `"${CLAUDE}" login`], { detached: true, stdio: "ignore" }).unref();
        } else {
          const inner = `${CLAUDE} login; echo; read -p 'Press enter to close...'`;
          const tried = [
            ["gnome-terminal", ["--", "sh", "-c", inner]],
            ["konsole", ["-e", "sh", "-c", inner]],
            ["xfce4-terminal", ["-e", inner]],
            ["kitty", ["sh", "-c", inner]],
            ["alacritty", ["-e", "sh", "-c", inner]],
            ["x-terminal-emulator", ["-e", "sh", "-c", inner]],
          ];
          let ok = false;
          for (const [prog, args] of tried) {
            try {
              spawn(prog, args, { detached: true, stdio: "ignore" }).unref();
              ok = true;
              break;
            } catch { /* try next */ }
          }
          if (!ok) {
            return jsonResponse(req, res, { error: "Aucun terminal compatible trouvé. Ouvrez un terminal et tapez: claude login" }, 500);
          }
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/gh-merge-pr  { cwd, number, method }
    if (url.pathname === "/api/gh-merge-pr" && req.method === "POST") {
      try {
        const { cwd, number, method } = await readBody(req);
        if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
        const mergeFlag = method === "squash" ? "--squash"
          : method === "rebase" ? "--rebase"
          : "--merge";
        const r = spawnSync(GH, ["pr", "merge", String(number), mergeFlag, "--delete-branch"], {
          cwd: resolve(cwd),
          encoding: "utf-8",
        });
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "gh pr merge failed";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-interactive-rebase  { cwd, base, todoLines }
    // Starts an interactive rebase with a custom todo list.
    // Writes a temp file and uses GIT_SEQUENCE_EDITOR to inject it.
    // Uses async spawn (NOT spawnSync) to avoid blocking the event loop.
    if (url.pathname === "/api/git-interactive-rebase" && req.method === "POST") {
      try {
        const { cwd, base, todoLines } = await readBody(req);
        if (!cwd || !base || !todoLines) {
          return jsonResponse(req, res, { error: "Missing cwd, base, or todoLines" }, 400);
        }
        const resolvedCwd = resolve(cwd);
        const todoContent = todoLines.join("\n") + "\n";
        const tmpFile = join(tmpdir(), `gitwand-rebase-todo-${Date.now()}.txt`);
        writeFileSync(tmpFile, todoContent, "utf-8");

        const editorCmd = process.platform === "win32"
          ? `copy /Y "${tmpFile}"`
          : `cp "${tmpFile}"`;

        console.log("[rebase] Starting: git rebase -i", base, "in", resolvedCwd);

        const result = await new Promise((resolveP, rejectP) => {
          const child = spawn(GIT, ["rebase", "-i", base], {
            cwd: resolvedCwd,
            env: {
              ...process.env,
              GIT_SEQUENCE_EDITOR: editorCmd,
              GIT_EDITOR: "true",
              EDITOR: "true",
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          // Close stdin immediately so git never blocks waiting for input
          child.stdin.end();

          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => { stdout += d.toString(); });
          child.stderr.on("data", (d) => { stderr += d.toString(); });

          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            rejectP(new Error("Rebase timed out after 30s"));
          }, 30_000);

          child.on("close", (code) => {
            clearTimeout(timer);
            console.log("[rebase] Done, exit code:", code, "stderr:", stderr.slice(0, 200));
            resolveP({ code, stdout, stderr });
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            console.error("[rebase] spawn error:", err);
            rejectP(err);
          });
        });

        // Clean up temp file
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

        if (result.code !== 0) {
          const stderr = result.stderr ?? "";
          const stdout = result.stdout ?? "";
          // Match the Rust git_interactive_rebase: git writes conflict markers
          // to either stream depending on version/locale.
          const blob = stderr + stdout;
          if (blob.includes("CONFLICT") || blob.includes("could not apply")) {
            return jsonResponse(req, res, { ok: true, conflict: true });
          }
          return jsonResponse(req, res, { error: stderr || "Rebase failed" }, 500);
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        console.error("[rebase] Error:", err);
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-exec  { cwd, args }
    // Generic git command execution — mirrors the Rust `git_exec` Tauri command.
    // Used by useCommitMessage to get the staged diff.
    if (url.pathname === "/api/git-exec" && req.method === "POST") {
      try {
        const { cwd: execCwd, args } = await readBody(req);
        if (!args || !Array.isArray(args) || args.length === 0) {
          return jsonResponse(req, res, { error: "No arguments provided" }, 400);
        }
        const r = spawnSync(GIT, args, {
          cwd: resolve(execCwd),
          encoding: "utf-8",
          maxBuffer: 20 * 1024 * 1024,
        });
        return jsonResponse(req, res, {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.status ?? -1,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/read-gitwandrc  { cwd }
    // Searches: .gitwandrc → .gitwandrc.json → package.json#gitwand
    if (url.pathname === "/api/read-gitwandrc" && req.method === "POST") {
      try {
        const { cwd } = await readBody(req);
        const base = resolve(cwd);

        // 1. .gitwandrc
        const rcPath = join(base, ".gitwandrc");
        if (existsSync(rcPath)) {
          return res.writeHead(200, { "Content-Type": "text/plain" }).end(readFileSync(rcPath, "utf-8"));
        }

        // 2. .gitwandrc.json
        const rcJsonPath = join(base, ".gitwandrc.json");
        if (existsSync(rcJsonPath)) {
          return res.writeHead(200, { "Content-Type": "text/plain" }).end(readFileSync(rcJsonPath, "utf-8"));
        }

        // 3. "gitwand" key in package.json
        const pkgPath = join(base, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            if (pkg.gitwand) {
              return res.writeHead(200, { "Content-Type": "text/plain" }).end(JSON.stringify(pkg.gitwand));
            }
          } catch { /* ignore parse errors */ }
        }

        // Not found — return empty string (same as Rust backend)
        return res.writeHead(200, { "Content-Type": "text/plain" }).end("");
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/write-gitwandrc  { cwd, content }
    // Mirror of read-gitwandrc: writes .gitwandrc.json if present,
    // otherwise .gitwandrc (JSONC-friendly default). Validates content
    // as JSON before persisting — fails loudly on malformed input.
    if (url.pathname === "/api/write-gitwandrc" && req.method === "POST") {
      try {
        const { cwd, content } = await readBody(req);
        if (!cwd || typeof cwd !== "string") {
          return jsonResponse(req, res, { error: "cwd must be a non-empty string" }, 400);
        }
        if (typeof content !== "string") {
          return jsonResponse(req, res, { error: "content must be a string" }, 400);
        }
        // Validate JSON shape — same guard as the Rust path.
        try {
          JSON.parse(content);
        } catch (e) {
          return jsonResponse(req, res, { error: `Invalid JSON for .gitwandrc: ${e.message}` }, 400);
        }
        const base = resolve(cwd);
        const rcJsonPath = join(base, ".gitwandrc.json");
        const rcPath = join(base, ".gitwandrc");
        const target = existsSync(rcJsonPath) ? rcJsonPath : rcPath;
        writeFileSync(target, content, "utf-8");
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Git Hooks ──────────────────────────────────────────────

    const HOOK_NAMES_ORDER = [
      "pre-commit","prepare-commit-msg","commit-msg","post-commit",
      "pre-push","pre-rebase","post-checkout","post-merge",
      "pre-receive","update","post-receive","post-update","post-rewrite",
      "applypatch-msg","pre-applypatch","post-applypatch","pre-auto-gc","sendemail-validate",
    ];

    // GET /api/git-hook-list?cwd=<path>
    if (url.pathname === "/api/git-hook-list" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const hooksDir = join(cwd, ".git", "hooks");
        if (!existsSync(hooksDir)) return jsonResponse(req, res, []);
        const files = readdirSync(hooksDir).filter(f => !f.endsWith(".sample"));
        const seen = new Set();
        const entries = [];
        for (const fname of files) {
          const isDisabled = fname.endsWith(".disabled");
          const name = isDisabled ? fname.slice(0, -".disabled".length) : fname;
          if (seen.has(name)) continue;
          seen.add(name);
          const fpath = join(hooksDir, fname);
          const stat = statSync(fpath);
          const executable = (stat.mode & 0o111) !== 0;
          const content = readFileSync(fpath, "utf-8");
          const preview = content.split("\n").find(l => l.trim()) || "";
          entries.push({ name, enabled: !isDisabled, executable, preview: preview.slice(0, 80) });
        }
        entries.sort((a, b) => {
          const ai = HOOK_NAMES_ORDER.indexOf(a.name);
          const bi = HOOK_NAMES_ORDER.indexOf(b.name);
          if (ai >= 0 && bi >= 0) return ai - bi;
          if (ai >= 0) return -1;
          if (bi >= 0) return 1;
          return a.name.localeCompare(b.name);
        });
        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-hook-toggle  { cwd, name, enabled }
    if (url.pathname === "/api/git-hook-toggle" && req.method === "POST") {
      try {
        const { cwd, name, enabled } = await readBody(req);
        if (!name || name.includes("/") || name.includes("\\") || name.includes(".")) {
          return jsonResponse(req, res, { error: "Invalid hook name" }, 400);
        }
        const hooksDir = join(resolve(cwd), ".git", "hooks");
        const enabledPath = join(hooksDir, name);
        const disabledPath = join(hooksDir, `${name}.disabled`);
        if (enabled && existsSync(disabledPath)) renameSync(disabledPath, enabledPath);
        else if (!enabled && existsSync(enabledPath)) renameSync(enabledPath, disabledPath);
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-hook-create  { cwd, name, content }
    if (url.pathname === "/api/git-hook-create" && req.method === "POST") {
      try {
        const { cwd, name, content } = await readBody(req);
        if (!name || name.includes("/") || name.includes("\\") || name.includes(".")) {
          return jsonResponse(req, res, { error: "Invalid hook name" }, 400);
        }
        const hooksDir = join(resolve(cwd), ".git", "hooks");
        mkdirSync(hooksDir, { recursive: true });
        const script = content.startsWith("#!") ? content : `#!/usr/bin/env bash\n${content}`;
        writeFileSync(join(hooksDir, name), script, { mode: 0o755 });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-hook-delete  { cwd, name }
    if (url.pathname === "/api/git-hook-delete" && req.method === "POST") {
      try {
        const { cwd, name } = await readBody(req);
        if (!name || name.includes("/") || name.includes("\\") || name.includes(".")) {
          return jsonResponse(req, res, { error: "Invalid hook name" }, 400);
        }
        const hooksDir = join(resolve(cwd), ".git", "hooks");
        const enabledPath = join(hooksDir, name);
        const disabledPath = join(hooksDir, `${name}.disabled`);
        if (existsSync(enabledPath)) unlinkSync(enabledPath);
        if (existsSync(disabledPath)) unlinkSync(disabledPath);
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Workspaces ─────────────────────────────────────────────

    // GET /api/workspace-read?path=<dir>
    if (url.pathname === "/api/workspace-read" && req.method === "GET") {
      try {
        const dir = resolve(url.searchParams.get("path") || "");
        const file = join(dir, ".gitwand-workspace.json");
        if (!existsSync(file)) return jsonResponse(req, res, { error: "No workspace file found" }, 404);
        return jsonResponse(req, res, JSON.parse(readFileSync(file, "utf-8")));
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-write  { path, workspace }
    if (url.pathname === "/api/workspace-write" && req.method === "POST") {
      try {
        const { path: dir, workspace } = await readBody(req);
        const file = join(resolve(dir), ".gitwand-workspace.json");
        writeFileSync(file, JSON.stringify(workspace, null, 2));
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-status-all  { repos: [{ path, name }] }
    if (url.pathname === "/api/workspace-status-all" && req.method === "POST") {
      try {
        const { repos } = await readBody(req);
        const statuses = repos.map(repo => {
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo.path, encoding: "utf-8" }).trim();
            let ahead = 0, behind = 0;
            try {
              const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: repo.path, encoding: "utf-8" }).trim().split(/\s+/);
              ahead = parseInt(ab[0]) || 0; behind = parseInt(ab[1]) || 0;
            } catch {}
            const modified = execSync("git status --porcelain --untracked-files=no", { cwd: repo.path, encoding: "utf-8" }).trim().split("\n").filter(Boolean).length;
            return { path: repo.path, name: repo.name, branch, ahead, behind, modified, error: null };
          } catch (e) {
            return { path: repo.path, name: repo.name, branch: "", ahead: 0, behind: 0, modified: 0, error: e.message };
          }
        });
        return jsonResponse(req, res, statuses);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-fetch-all  { repos }
    if (url.pathname === "/api/workspace-fetch-all" && req.method === "POST") {
      try {
        const { repos } = await readBody(req);
        for (const repo of repos) {
          try { execSync("git fetch --all --prune", { cwd: repo.path, encoding: "utf-8" }); } catch {}
        }
        // Return updated statuses
        const statuses = repos.map(repo => {
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo.path, encoding: "utf-8" }).trim();
            let ahead = 0, behind = 0;
            try {
              const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: repo.path, encoding: "utf-8" }).trim().split(/\s+/);
              ahead = parseInt(ab[0]) || 0; behind = parseInt(ab[1]) || 0;
            } catch {}
            const modified = execSync("git status --porcelain --untracked-files=no", { cwd: repo.path, encoding: "utf-8" }).trim().split("\n").filter(Boolean).length;
            return { path: repo.path, name: repo.name, branch, ahead, behind, modified, error: null };
          } catch (e) {
            return { path: repo.path, name: repo.name, branch: "", ahead: 0, behind: 0, modified: 0, error: e.message };
          }
        });
        return jsonResponse(req, res, statuses);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-pull-all  { repos }
    if (url.pathname === "/api/workspace-pull-all" && req.method === "POST") {
      try {
        const { repos } = await readBody(req);
        for (const repo of repos) {
          try { execSync("git pull --ff-only", { cwd: repo.path, encoding: "utf-8" }); } catch {}
        }
        const statuses = repos.map(repo => {
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo.path, encoding: "utf-8" }).trim();
            let ahead = 0, behind = 0;
            try {
              const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: repo.path, encoding: "utf-8" }).trim().split(/\s+/);
              ahead = parseInt(ab[0]) || 0; behind = parseInt(ab[1]) || 0;
            } catch {}
            const modified = execSync("git status --porcelain --untracked-files=no", { cwd: repo.path, encoding: "utf-8" }).trim().split("\n").filter(Boolean).length;
            return { path: repo.path, name: repo.name, branch, ahead, behind, modified, error: null };
          } catch (e) {
            return { path: repo.path, name: repo.name, branch: "", ahead: 0, behind: 0, modified: 0, error: e.message };
          }
        });
        return jsonResponse(req, res, statuses);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-wip-all  { repos: [{ path, name }] }
    if (url.pathname === "/api/workspace-wip-all" && req.method === "POST") {
      try {
        const { repos } = await readBody(req);
        const items = repos.map(repo => {
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo.path, encoding: "utf-8" }).trim();

            let ahead = 0, behind = 0, has_no_upstream = false;
            try {
              const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: repo.path, encoding: "utf-8" }).trim().split(/\s+/);
              ahead = parseInt(ab[0]) || 0;
              behind = parseInt(ab[1]) || 0;
            } catch {
              has_no_upstream = true;
            }

            const statusOut = execSync("git status --porcelain", { cwd: repo.path, encoding: "utf-8" });
            let staged_count = 0, unstaged_count = 0, untracked_count = 0;
            for (const line of statusOut.split("\n").filter(l => l.length >= 2)) {
              const x = line[0], y = line[1];
              if (x === "?" && y === "?") {
                untracked_count++;
              } else {
                if (x !== " " && x !== "?" && x !== "!") staged_count++;
                if (y !== " " && y !== "?" && y !== "!") unstaged_count++;
              }
            }

            let last_commit_at = "";
            try {
              last_commit_at = execSync("git log -1 --format=%cI", { cwd: repo.path, encoding: "utf-8" }).trim();
            } catch {}

            const changed_files = [];
            const seenFiles = new Set();
            for (const line of statusOut.split("\n")) {
              if (line.length < 4) continue;
              if (line[0] === "?" && line[1] === "?") continue; // skip untracked
              const pathPart = line.slice(3).trim();
              const rawPath = pathPart.includes(" -> ")
                ? pathPart.split(" -> ").pop()
                : pathPart;
              // Strip surrounding double-quotes git adds for filenames with spaces
              const filePath = rawPath ? rawPath.replace(/^"|"$/g, "") : null;
              if (filePath && !seenFiles.has(filePath)) {
                seenFiles.add(filePath);
                changed_files.push(filePath);
              }
            }
            changed_files.sort();

            return {
              path: repo.path, name: repo.name, branch,
              ahead, behind,
              staged_count, unstaged_count, untracked_count,
              last_commit_at, has_no_upstream,
              changed_files,
              error: null,
            };
          } catch (e) {
            return {
              path: repo.path, name: repo.name, branch: "",
              ahead: 0, behind: 0,
              staged_count: 0, unstaged_count: 0, untracked_count: 0,
              last_commit_at: "", has_no_upstream: false,
              changed_files: [],
              error: e.message,
            };
          }
        });
        return jsonResponse(req, res, items);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-prs-all  { repos: [{ path, name }] }
    if (url.pathname === "/api/workspace-prs-all" && req.method === "POST") {
      try {
        const { repos } = await readBody(req);
        const results = repos.map(repo => {
          try {
            // v2.16: re-enriched with CI / review / comment fields so the
            // Launchpad notification diff (useLaunchpadNotifications) can detect
            // CI flips, review requests and new comments. Mirror of the Rust
            // change in `commands/workspace.rs`. This runs on the background
            // Launchpad poller (~60 s), so the extra cost is acceptable.
            const raw = execSync(
              "gh pr list --state open --json number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,labels,assignees,reviewRequests,reviewDecision,mergeStateStatus,statusCheckRollup,comments --limit 10",
              { cwd: repo.path, encoding: "utf-8" }
            );
            const ghPrs = JSON.parse(raw || "[]");
            const prs = ghPrs.map(pr => ({
              number: pr.number,
              title: pr.title ?? "",
              state: pr.state ?? "",
              author: pr.author?.login ?? "",
              branch: pr.headRefName ?? "",
              base: pr.baseRefName ?? "",
              draft: pr.isDraft ?? false,
              created_at: pr.createdAt ?? "",
              updated_at: pr.updatedAt ?? "",
              url: pr.url ?? "",
              additions: pr.additions ?? 0,
              deletions: pr.deletions ?? 0,
              labels: (pr.labels ?? []).map(l => l.name),
              assignees: (pr.assignees ?? []).map(a => a.login).filter(Boolean),
              review_requested: (pr.reviewRequests ?? [])
                .map(rr => rr.login)
                .filter(Boolean),
              review_decision: pr.reviewDecision ?? "",
              merge_state_status: pr.mergeStateStatus ?? "",
              checks_rollup: (pr.statusCheckRollup ?? [])
                .map(c => c.conclusion)
                .find(c => !!c) ?? "",
              comment_count: (pr.comments ?? []).length,
            }));
            return { repo_path: repo.path, repo_name: repo.name, prs, error: null };
          } catch (e) {
            return {
              repo_path: repo.path, repo_name: repo.name,
              prs: [],
              error: e.message,
            };
          }
        });
        return jsonResponse(req, res, results);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/workspace-issues-all  { repos: [{ path, name }], filter: "" | "assigned" | "mentioned" | "created" }
    if (url.pathname === "/api/workspace-issues-all" && req.method === "POST") {
      try {
        const { repos, filter = "" } = await readBody(req);
        const results = repos.map(repo => {
          try {
            // Build gh args dynamically based on filter (mirrors Rust workspace_issues_all)
            let cmd = "gh issue list --state open --json number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone --limit 100";
            if (filter === "assigned") cmd += " --assignee @me";
            else if (filter === "created") cmd += " --author @me";
            else if (filter === "mentioned") cmd += " --search mentions:@me";

            const raw = execSync(cmd, { cwd: repo.path, encoding: "utf-8" });
            const ghIssues = JSON.parse(raw || "[]");
            // Emit camelCase directly to match Tauri's Issue#[serde(rename_all = "camelCase")] output
            const issues = ghIssues.map(issue => ({
              number: issue.number,
              title: issue.title ?? "",
              state: issue.state ?? "",
              author: issue.author?.login ?? "",
              assignees: (issue.assignees ?? []).map(a => a.login).filter(Boolean),
              labels: (issue.labels ?? []).map(l => l.name),
              url: issue.url ?? "",
              createdAt: issue.createdAt ?? "",
              updatedAt: issue.updatedAt ?? "",
              milestone: issue.milestone?.title ?? "",
            }));
            return { repo_path: repo.path, repo_name: repo.name, issues, filter, error: null };
          } catch (e) {
            return { repo_path: repo.path, repo_name: repo.name, issues: [], filter, error: e.message };
          }
        });
        return jsonResponse(req, res, results);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gh-list-issues?cwd=<path>&filter=<""|assigned|mentioned|created>&limit=<n>
    if (url.pathname === "/api/gh-list-issues" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const filter = url.searchParams.get("filter") || "";
      const limit = url.searchParams.get("limit") || "100";
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      try {
        let cmd = `gh issue list --state open --json number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone --limit ${parseInt(limit)}`;
        if (filter === "assigned") cmd += " --assignee @me";
        else if (filter === "created") cmd += " --author @me";
        else if (filter === "mentioned") cmd += " --search mentions:@me";
        const raw = execSync(cmd, { cwd: resolve(cwd), encoding: "utf-8" });
        const ghIssues = JSON.parse(raw || "[]");
        const issues = ghIssues.map((issue) => ({
          number: issue.number,
          title: issue.title ?? "",
          state: issue.state ?? "",
          author: issue.author?.login ?? "",
          assignees: (issue.assignees ?? []).map((a) => a.login).filter(Boolean),
          labels: (issue.labels ?? []).map((l) => l.name),
          url: issue.url ?? "",
          createdAt: issue.createdAt ?? "",
          updatedAt: issue.updatedAt ?? "",
          milestone: issue.milestone?.title ?? "",
        }));
        return jsonResponse(req, res, issues);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/gl-list-issues — dev mock (no glab in dev:web)
    if (url.pathname === "/api/gl-list-issues" && req.method === "GET") {
      return jsonResponse(req, res, [
        {
          number: 101, title: "[mock] GitLab issue", state: "open", author: "devuser",
          assignees: ["devuser"], labels: ["mock"], url: "https://gitlab.com/mock/repo/-/issues/101",
          createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-20T00:00:00Z", milestone: "",
        },
      ]);
    }

    // GET /api/bb-list-issues — dev mock (no curl creds in dev:web)
    if (url.pathname === "/api/bb-list-issues" && req.method === "GET") {
      return jsonResponse(req, res, [
        {
          number: 5, title: "[mock] Bitbucket issue", state: "new", author: "devuser",
          assignees: [], labels: [], url: "https://bitbucket.org/mock/repo/issues/5",
          createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-19T00:00:00Z", milestone: "",
        },
      ]);
    }

    // GET /api/git-worktree-status-all?cwd=<path>
    if (url.pathname === "/api/git-worktree-status-all" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const raw = execSync("git worktree list --porcelain", { cwd, encoding: "utf-8" });
        const worktrees = [];
        let cur = null;
        for (const line of raw.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (cur) worktrees.push(cur);
            cur = { path: line.slice("worktree ".length) };
          } else if (cur && line.startsWith("branch ")) {
            cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
          } else if (cur && line === "detached") {
            cur.branch = "(detached)";
          }
        }
        if (cur) worktrees.push(cur);

        const CONFLICT_CODES = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
        const statuses = worktrees.map(wt => {
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: wt.path, encoding: "utf-8" }).trim();
            let ahead = 0, behind = 0, has_upstream = false;
            try {
              const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: wt.path, encoding: "utf-8" }).trim().split(/\s+/);
              ahead = parseInt(ab[0]) || 0; behind = parseInt(ab[1]) || 0;
              has_upstream = true;
            } catch {}
            const statusLines = execSync("git status --porcelain --untracked-files=no", { cwd: wt.path, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
            const conflicted = statusLines.filter(l => l.length >= 2 && CONFLICT_CODES.has(l.slice(0, 2))).length;
            const modified = statusLines.filter(l => l.length >= 2 && !CONFLICT_CODES.has(l.slice(0, 2))).length;
            return { path: wt.path, name: wt.branch || branch, branch, ahead, behind, has_upstream, modified, conflicted, error: null };
          } catch (e) {
            return { path: wt.path, name: wt.branch || "", branch: "", ahead: 0, behind: 0, has_upstream: false, modified: 0, conflicted: 0, error: e.message };
          }
        });
        return jsonResponse(req, res, statuses);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Worktrees ──────────────────────────────────────────────

    // GET /api/git-worktree-list?cwd=<path>
    if (url.pathname === "/api/git-worktree-list" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const raw = execSync("git worktree list --porcelain", { cwd, encoding: "utf-8" });
        const entries = [];
        let current = null;
        for (const line of raw.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current) entries.push(current);
            current = { path: line.slice("worktree ".length), branch: "", head: "", is_main: false, is_locked: false, lock_reason: null, is_bare: false, is_prunable: false, prunable_reason: null };
          } else if (current) {
            if (line === "main") current.is_main = true;
            else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
            else if (line.startsWith("branch ")) {
              const full = line.slice("branch ".length);
              current.branch = full.startsWith("refs/heads/") ? full.slice("refs/heads/".length) : full;
            } else if (line === "bare") current.is_bare = true;
            else if (line.startsWith("locked")) {
              current.is_locked = true;
              const reason = line.slice("locked".length).trim();
              if (reason) current.lock_reason = reason;
            } else if (line.startsWith("prunable")) {
              current.is_prunable = true;
              const reason = line.slice("prunable".length).trim();
              if (reason) current.prunable_reason = reason;
            } else if (line === "detached") current.branch = "(detached HEAD)";
          }
        }
        if (current) entries.push(current);
        // Fallback git < 2.36 : marquer le premier comme main si aucun ne l'est
        if (entries.length && entries.every(e => !e.is_main)) entries[0].is_main = true;
        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-worktree-add  { cwd, path, branch, new_branch? }
    if (url.pathname === "/api/git-worktree-add" && req.method === "POST") {
      try {
        const { cwd, path: wtPath, branch, new_branch } = await readBody(req);
        const resolvedCwd = resolve(cwd);

        // Ensure parent directories exist
        const parentDir = dirname(wtPath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        let cmd = `git worktree add "${wtPath}"`;
        if (new_branch) cmd += ` -b "${new_branch}" "${branch}"`;
        else cmd += ` "${branch}"`;
        execSync(cmd, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        const resolvedBranch = new_branch || branch;
        let head = "";
        try { head = execSync("git rev-parse HEAD", { cwd: wtPath, encoding: "utf-8" }).trim(); } catch {}
        return jsonResponse(req, res, { path: wtPath, branch: resolvedBranch, head, is_main: false, is_locked: false, lock_reason: null, is_bare: false, is_prunable: false, prunable_reason: null });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-worktree-remove  { cwd, path, force? }
    if (url.pathname === "/api/git-worktree-remove" && req.method === "POST") {
      try {
        const { cwd, path: wtPath, force } = await readBody(req);
        const resolvedCwd = resolve(cwd);
        const forceFlag = force ? "--force " : "";
        execSync(`git worktree remove ${forceFlag}"${wtPath}"`, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-worktree-prune  { cwd }
    if (url.pathname === "/api/git-worktree-prune" && req.method === "POST") {
      try {
        const { cwd } = await readBody(req);
        execSync("git worktree prune", { cwd: resolve(cwd), encoding: "utf-8" });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-worktree-repair  { cwd, paths? }
    if (url.pathname === "/api/git-worktree-repair" && req.method === "POST") {
      try {
        const { cwd, paths = [] } = await readBody(req);
        const extraPaths = paths.map(p => `"${p}"`).join(" ");
        execSync(`git worktree repair ${extraPaths}`.trim(), { cwd: resolve(cwd), encoding: "utf-8", shell: true });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Agent Sessions ─────────────────────────────────────────

    // GET /api/agent-session-list?cwd=<path>
    if (url.pathname === "/api/agent-session-list" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const wtRaw = execSync("git worktree list --porcelain", { cwd, encoding: "utf-8" });
        const worktrees = [];
        let cur = {};
        for (const line of wtRaw.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (cur.path) worktrees.push(cur);
            cur = { path: line.slice(9).trim() };
          } else if (line.startsWith("branch ")) {
            cur.branch = line.slice(7).trim().replace("refs/heads/", "");
          }
        }
        if (cur.path) worktrees.push(cur);

        const AGENT_DIRS = { claude: ".claude", cursor: ".cursor", windsurf: ".windsurf" };
        const sessions = [];
        for (const wt of worktrees) {
          let tool = null;
          for (const [name, dir] of Object.entries(AGENT_DIRS)) {
            if (existsSync(join(wt.path, dir))) { tool = name; break; }
          }
          if (!tool && existsSync(join(wt.path, ".mcp.json"))) tool = "other";
          if (!tool) continue;

          let ahead = 0, behind = 0;
          try {
            const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: wt.path, encoding: "utf-8" }).trim().split(/\s+/);
            ahead = parseInt(ab[0]) || 0; behind = parseInt(ab[1]) || 0;
          } catch {}

          let modified = 0;
          try {
            const st = execSync("git status --porcelain --untracked-files=no", { cwd: wt.path, encoding: "utf-8" });
            modified = st.split("\n").filter(Boolean).length;
          } catch {}

          let branch = wt.branch || "";
          try { branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: wt.path, encoding: "utf-8" }).trim(); } catch {}

          sessions.push({ path: wt.path, branch, tool, active: false, ahead, behind, modified });
        }
        return jsonResponse(req, res, sessions);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/agent-session-launch  { cwd, tool }
    if (url.pathname === "/api/agent-session-launch" && req.method === "POST") {
      try {
        const { cwd, tool } = await readBody(req);
        const binary = tool === "cursor" ? "cursor" : tool === "windsurf" ? "windsurf" : "claude";
        spawn(binary, [], { cwd: resolve(cwd), detached: true, stdio: "ignore" }).unref();
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ─── Submodules ─────────────────────────────────────────────

    // GET /api/git-submodule-list?cwd=<path>
    if (url.pathname === "/api/git-submodule-list" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const gitmodulesPath = join(cwd, ".gitmodules");
        if (!existsSync(gitmodulesPath)) return jsonResponse(req, res, []);

        // Parse .gitmodules via git config
        const cfgRaw = execSync("git config --file .gitmodules --list", { cwd, encoding: "utf-8" });
        const urlMap = {};
        const branchMap = {};
        const pathToName = {};
        for (const line of cfgRaw.split("\n")) {
          const eq = line.indexOf("=");
          if (eq === -1) continue;
          const key = line.slice(0, eq);
          const val = line.slice(eq + 1);
          const nameMatch = key.match(/^submodule\.(.+)\.(\w+)$/);
          if (!nameMatch) continue;
          const [, name, prop] = nameMatch;
          if (prop === "url") urlMap[name] = val;
          else if (prop === "branch") branchMap[name] = val;
          else if (prop === "path") pathToName[val] = name;
        }

        // Parse git submodule status
        let statusRaw = "";
        try { statusRaw = execSync("git submodule status", { cwd, encoding: "utf-8" }); } catch { /* no submodules inited */ }
        const entries = [];
        for (const line of statusRaw.split("\n")) {
          if (line.length < 42) continue;
          const prefix = line[0];
          const rest = line.slice(1);
          const spaceIdx = rest.indexOf(" ");
          const sha = rest.slice(0, spaceIdx);
          const pathAndRest = rest.slice(spaceIdx + 1);
          const subPath = pathAndRest.split(" ")[0];
          const status = prefix === "-" ? "uninitialized" : prefix === "+" ? "modified" : "clean";
          const name = pathToName[subPath] || subPath;
          entries.push({ path: subPath, url: urlMap[name] || "", sha, branch: branchMap[name] || null, status });
        }
        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-submodule-init  { cwd }
    if (url.pathname === "/api/git-submodule-init" && req.method === "POST") {
      try {
        const { cwd } = await readBody(req);
        execSync("git submodule init", { cwd: resolve(cwd), encoding: "utf-8" });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-submodule-update  { cwd, init, recursive }
    if (url.pathname === "/api/git-submodule-update" && req.method === "POST") {
      try {
        const { cwd, init, recursive } = await readBody(req);
        let cmd = "git submodule update";
        if (init) cmd += " --init";
        if (recursive) cmd += " --recursive";
        execSync(cmd, { cwd: resolve(cwd), encoding: "utf-8", shell: true });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-submodule-add  { cwd, url, path }
    if (url.pathname === "/api/git-submodule-add" && req.method === "POST") {
      try {
        const { cwd, url: smUrl, path: smPath } = await readBody(req);
        execSync(`git submodule add "${smUrl}" "${smPath}"`, { cwd: resolve(cwd), encoding: "utf-8", shell: true });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-submodule-branches?cwd=<path>&path=<submodulePath>
    // Mirrors the Tauri `git_submodule_branches` command (v2.15.1).
    if (url.pathname === "/api/git-submodule-branches" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const subPath = url.searchParams.get("path") || "";
        const subDir = join(cwd, subPath);
        if (!existsSync(subDir)) return jsonResponse(req, res, []);
        // spawnSync (no shell) — the `%(HEAD)` format token contains parens
        // that break /bin/sh if passed through execSync's string form.
        const r = spawnSync(GIT, ["branch", "--format=%(HEAD)%(refname:short)"], { cwd: subDir, encoding: "utf-8" });
        if (r.status !== 0) {
          return jsonResponse(req, res, { error: (r.stderr || "git branch failed").trim() }, 500);
        }
        const raw = r.stdout || "";
        const branches = [];
        for (const line of raw.split("\n")) {
          const trimmed = line.replace(/\s+$/, "");
          if (!trimmed) continue;
          const isCurrent = trimmed.startsWith("*");
          const name = trimmed.replace(/^\*/, "").trim();
          if (!name) continue;
          branches.push({ name, isCurrent });
        }
        return jsonResponse(req, res, branches);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // GET /api/git-commit-submodule-changes?cwd=<path>
    // Mirrors the Tauri `git_commit_submodule_changes` command (v2.15.1).
    if (url.pathname === "/api/git-commit-submodule-changes" && req.method === "GET") {
      try {
        const cwd = resolve(url.searchParams.get("cwd") || "");
        const gitmodulesPath = join(cwd, ".gitmodules");
        if (!existsSync(gitmodulesPath)) return jsonResponse(req, res, {});

        let cfgRaw = "";
        try { cfgRaw = execSync("git config --file .gitmodules --get-regexp path", { cwd, encoding: "utf-8" }); } catch { /* none */ }
        const subPaths = [];
        for (const line of cfgRaw.split("\n")) {
          const sp = line.indexOf(" ");
          if (sp === -1) continue;
          const p = line.slice(sp + 1).trim();
          if (p) subPaths.push(p);
        }
        if (subPaths.length === 0) return jsonResponse(req, res, {});

        const pathArgs = subPaths.map((p) => `"${p}"`).join(" ");
        const raw = execSync(
          `git log --format=GWCOMMIT:%H --raw --no-abbrev --no-renames -- ${pathArgs}`,
          { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
        );
        const map = {};
        let current = null;
        for (const line of raw.split("\n")) {
          if (line.startsWith("GWCOMMIT:")) {
            current = line.slice("GWCOMMIT:".length);
            continue;
          }
          if (!line.startsWith(":")) continue;
          const tab = line.indexOf("\t");
          if (tab === -1) continue;
          const meta = line.slice(1, tab);
          const path = line.slice(tab + 1);
          const fields = meta.split(/\s+/);
          if (fields.length < 4) continue;
          const [srcMode, dstMode, , newSha] = fields;
          if (srcMode !== "160000" && dstMode !== "160000") continue;
          if (/^0+$/.test(newSha)) continue;
          if (!current) continue;
          (map[current] ||= []).push({ path, pointedSha: newSha });
        }
        return jsonResponse(req, res, map);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // GET /api/git-remote-info?cwd=<path>
    // Mirrors the Tauri `git_remote_info` command: parses the first
    // `(fetch)` line from `git remote -v`, detects the hosting provider,
    // and extracts owner/repo from SSH or HTTPS URLs.
    if (url.pathname === "/api/git-remote-info" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const r = spawnSync(GIT, ["remote", "-v"], { cwd: resolvedCwd, encoding: "utf-8" });
        if (r.status !== 0) {
          return jsonResponse(req, res, { error: r.stderr || "git remote failed" }, 500);
        }
        const lines = (r.stdout || "").split("\n");
        // Prefer `origin` over whatever sorts first — `git remote -v` lists
        // remotes alphabetically, so a `fork` remote would otherwise shadow
        // `origin` and target the wrong repo. Mirrors the Rust command.
        let name = "";
        let remoteUrl = "";
        let firstName = "";
        let firstUrl = "";
        for (const line of lines) {
          if (!line.includes("(fetch)")) continue;
          const parts = line.split(/\s+/).filter(Boolean);
          if (parts.length < 2) continue;
          if (parts[0] === "origin") {
            name = parts[0];
            remoteUrl = parts[1];
            break;
          }
          if (!firstUrl) {
            firstName = parts[0];
            firstUrl = parts[1];
          }
        }
        if (!remoteUrl) {
          name = firstName;
          remoteUrl = firstUrl;
        }
        if (!remoteUrl) {
          return jsonResponse(req, res, { error: "No remote found" }, 404);
        }
        let provider = "unknown";
        if (remoteUrl.includes("github.com")) provider = "github";
        else if (remoteUrl.includes("gitlab")) provider = "gitlab";
        else if (remoteUrl.includes("bitbucket")) provider = "bitbucket";
        else if (remoteUrl.includes("dev.azure.com") || remoteUrl.includes("visualstudio.com")) provider = "azure";

        // Extract owner/repo — SSH (git@host:owner/repo.git) or HTTPS.
        let owner = "";
        let repo = "";
        const sshMatch = remoteUrl.match(/^git@[^:]+:(.+?)\/(.+?)(?:\.git)?$/);
        if (sshMatch) {
          owner = sshMatch[1];
          repo = sshMatch[2];
        } else {
          const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/(.+?)\/(.+?)(?:\.git)?$/);
          if (httpsMatch) {
            owner = httpsMatch[1];
            repo = httpsMatch[2];
          }
        }
        return jsonResponse(req, res, { name, url: remoteUrl, provider, owner, repo });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/check-remote-reachable  { url, timeoutMs }
    // Mirrors the Tauri `check_remote_reachable` command — TCP-connect probe
    // to the host extracted from a git remote URL. Returns { reachable: bool }.
    // Never throws on network failures: an unreachable host is a normal result.
    if (url.pathname === "/api/check-remote-reachable" && req.method === "POST") {
      const body = await readBody(req);
      const targetUrl = String(body?.url ?? "").trim();
      const timeoutMs = Math.max(250, Number(body?.timeoutMs ?? 2000) || 2000);
      const parsed = parseRemoteHostPort(targetUrl);
      if (!parsed) {
        return jsonResponse(req, res, { reachable: false });
      }
      const reachable = await tcpProbe(parsed.host, parsed.port, timeoutMs);
      return jsonResponse(req, res, { reachable });
    }

    // ── Commit context-menu operations (v1.9) ────────────────────────────

    // POST /api/git-checkout-commit  { cwd, sha }
    if (url.pathname === "/api/git-checkout-commit" && req.method === "POST") {
      const { cwd, sha } = await readBody(req);
      if (!cwd || !sha) return jsonResponse(req, res, { error: "Missing cwd or sha" }, 400);
      try {
        execFileSync(GIT, ["checkout", sha], { cwd: resolve(cwd) });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-reset-to-commit  { cwd, sha, mode }
    if (url.pathname === "/api/git-reset-to-commit" && req.method === "POST") {
      const { cwd, sha, mode } = await readBody(req);
      if (!cwd || !sha) return jsonResponse(req, res, { error: "Missing cwd or sha" }, 400);
      const flag = mode === "soft" ? "--soft" : mode === "hard" ? "--hard" : "--mixed";
      try {
        execFileSync(GIT, ["reset", flag, sha], { cwd: resolve(cwd) });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-revert-commit  { cwd, sha, mainline? }
    if (url.pathname === "/api/git-revert-commit" && req.method === "POST") {
      const { cwd, sha, mainline } = await readBody(req);
      if (!cwd || !sha) return jsonResponse(req, res, { error: "Missing cwd or sha" }, 400);
      try {
        const args = ["revert", "--no-edit"];
        if (mainline != null) { args.push("-m", String(mainline)); }
        args.push(sha);
        const out = spawnSync(GIT, args, { cwd: resolve(cwd), encoding: "utf-8" });
        const hasConflicts = (out.stderr || "").includes("CONFLICT") || (out.stdout || "").includes("CONFLICT");
        return jsonResponse(req, res, {
          success: out.status === 0,
          message: out.status === 0 ? (out.stdout || "") : (out.stderr || ""),
          conflicts: hasConflicts,
        });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-create-tag  { cwd, name, sha, message? }
    if (url.pathname === "/api/git-create-tag" && req.method === "POST") {
      const { cwd, name, sha, message } = await readBody(req);
      if (!cwd || !name || !sha) return jsonResponse(req, res, { error: "Missing cwd, name, or sha" }, 400);
      try {
        const args = message?.trim()
          ? ["tag", "-a", name, sha, "-m", message.trim()]
          : ["tag", name, sha];
        execFileSync(GIT, args, { cwd: resolve(cwd) });

        // Auto-push to remote directly as requested (v2.16)
        // We try 'origin' first, then fall back to the first available remote.
        try {
          const remotes = execFileSync(GIT, ["remote"], { cwd: resolve(cwd) }).toString().trim().split("\n").filter(Boolean);
          const remote = remotes.includes("origin") ? "origin" : remotes[0];
          if (remote) {
            execFileSync(GIT, ["push", remote, `refs/tags/${name}`], { cwd: resolve(cwd) });
          }
        } catch {
          // Ignore push errors (missing remote, offline, etc.)
        }

        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ── Tags manager (v1.9) ───────────────────────────────────────────────────

    // GET /api/git-list-tags?cwd=<path>
    if (url.pathname === "/api/git-list-tags" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        // Use \x1f (unit separator) — same as git_log, safe in Node child_process args
        const SEP = "\x1f";
        const fmt = `%(refname:short)${SEP}%(objecttype)${SEP}%(objectname:short)${SEP}%(*objectname:short)${SEP}%(taggerdate:iso)${SEP}%(creatordate:iso)${SEP}%(contents:subject)`;
        const out = spawnSync(GIT, ["tag", "-l", "--sort=-version:refname", "--sort=-creatordate", `--format=${fmt}`], { cwd: resolve(cwd), encoding: "utf-8" });
        const tags = (out.stdout || "").split("\n").map(line => {
          const parts = line.split(SEP);
          if (parts.length < 7) return null;
          const name = parts[0].trim();
          if (!name) return null;
          const isAnnotated = parts[1].trim() === "tag";
          const hash = isAnnotated && parts[3].trim() ? parts[3].trim() : parts[2].trim();
          const date = isAnnotated && parts[4].trim() ? parts[4].trim() : parts[5].trim();
          return { name, hash, is_annotated: isAnnotated, date, message: parts[6].trim() };
        }).filter(Boolean);
        return jsonResponse(req, res, tags);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-unpushed-tags?cwd=<path>&remote=<remote>
    if (url.pathname === "/api/git-unpushed-tags" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const remote = url.searchParams.get("remote") || "origin";
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const repoCwd = resolve(cwd);
        // local tags
        const localR = spawnSync(GIT, ["tag", "-l"], { cwd: repoCwd, encoding: "utf-8" });
        const localTags = new Set(
          (localR.stdout || "").split("\n").map(s => s.trim()).filter(Boolean)
        );
        if (localTags.size === 0) return jsonResponse(req, res, []);
        // remote tags
        const remoteR = spawnSync(GIT, ["ls-remote", "--tags", "--refs", remote], { cwd: repoCwd, encoding: "utf-8" });
        const remoteTags = new Set(
          (remoteR.stdout || "")
            .split("\n")
            .map(l => { const p = l.split("\t")[1]; return p ? p.replace("refs/tags/", "").trim() : ""; })
            .filter(Boolean)
        );
        const unpushed = [...localTags].filter(t => !remoteTags.has(t)).sort();
        return jsonResponse(req, res, unpushed);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-delete-tag  { cwd, name }
    if (url.pathname === "/api/git-delete-tag" && req.method === "POST") {
      const { cwd, name } = await readBody(req);
      if (!cwd || !name) return jsonResponse(req, res, { error: "Missing cwd or name" }, 400);
      try {
        execFileSync(GIT, ["tag", "-d", name], { cwd: resolve(cwd) });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-push-tags  { cwd, remote, mode, tagName? }
    if (url.pathname === "/api/git-push-tags" && req.method === "POST") {
      const { cwd, remote, mode, tagName } = await readBody(req);
      if (!cwd || !remote) return jsonResponse(req, res, { error: "Missing cwd or remote" }, 400);
      try {
        const args = ["push", remote];
        if (mode === "single" && tagName) { args.push(tagName); }
        else if (mode === "follow") { args.push("--follow-tags"); }
        else { args.push("--tags"); }
        execFileSync(GIT, args, { cwd: resolve(cwd) });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/git-delete-remote-tag  { cwd, remote, name }
    if (url.pathname === "/api/git-delete-remote-tag" && req.method === "POST") {
      const { cwd, remote, name } = await readBody(req);
      if (!cwd || !remote || !name) return jsonResponse(req, res, { error: "Missing cwd, remote, or name" }, 400);
      try {
        execFileSync(GIT, ["push", remote, "--delete", `refs/tags/${name}`], { cwd: resolve(cwd) });
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-shortlog?cwd=...
    // Mirror of Rust git_shortlog — full-history per-author summary.
    if (url.pathname === "/api/git-shortlog" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      const r = spawnSync(GIT, ["shortlog", "-sne", "--all"], {
        cwd: resolve(cwd),
        encoding: "utf-8",
      });
      if (r.status !== 0) {
        const detail = (r.stderr || r.stdout || "").trim() || "git shortlog failed";
        return jsonResponse(req, res, { error: detail }, 500);
      }
      const entries = [];
      for (const line of r.stdout.split("\n")) {
        const trimmed = line.trimStart();
        const tabIdx = trimmed.indexOf("\t");
        if (tabIdx < 0) continue;
        const count = parseInt(trimmed.slice(0, tabIdx).trim(), 10);
        if (Number.isNaN(count)) continue;
        const rest = trimmed.slice(tabIdx + 1).trim();
        const lt = rest.lastIndexOf("<");
        const gt = rest.lastIndexOf(">");
        if (lt < 0 || gt <= lt) continue;
        const name = rest.slice(0, lt).trim();
        const email = rest.slice(lt + 1, gt);
        entries.push({ name, email, count });
      }
      entries.sort((a, b) => b.count - a.count);
      return jsonResponse(req, res, entries);
    }

    // GET /api/git-branch-top-authors?cwd=...&branches=a,b,c
    // Mirror of Rust git_branch_top_authors — top contributor per branch.
    if (url.pathname === "/api/git-branch-top-authors" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      const resolvedCwd = resolve(cwd);
      const branches = (url.searchParams.get("branches") || "")
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      // Mirror get_main_branch_name in Rust.
      const base = (() => {
        for (const name of ["main", "master", "origin/main", "origin/master"]) {
          try {
            execSync(`git rev-parse --verify ${name}`, { cwd: resolvedCwd, stdio: "ignore" });
            return name;
          } catch { /* next */ }
        }
        return "main";
      })();
      // Top author for a revspec, or null.
      const shortlogTop = (branch, revspec) => {
        const r = spawnSync(GIT, ["shortlog", "-sne", revspec], {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        if (r.status !== 0) return null;
        let top = null;
        for (const line of r.stdout.split("\n")) {
          const trimmed = line.trimStart();
          const tabIdx = trimmed.indexOf("\t");
          if (tabIdx < 0) continue;
          const count = parseInt(trimmed.slice(0, tabIdx).trim(), 10);
          if (Number.isNaN(count)) continue;
          const rest = trimmed.slice(tabIdx + 1).trim();
          const lt = rest.lastIndexOf("<");
          const gt = rest.lastIndexOf(">");
          if (lt < 0 || gt <= lt) continue;
          const name = rest.slice(0, lt).trim();
          const email = rest.slice(lt + 1, gt);
          if (!top || count > top.count) top = { branch, name, email, count };
        }
        return top;
      };
      const results = [];
      for (const branch of branches) {
        // Commits unique to the branch first; fall back to full history.
        const top =
          shortlogTop(branch, `${base}..${branch}`) ?? shortlogTop(branch, branch);
        if (top) results.push(top);
      }
      return jsonResponse(req, res, results);
    }

    // ─── Clone & Fork (v2.0) ──────────────────────────────
    // Synchronous shell-outs — see Rust mirror in lib.rs for the rationale
    // around deferring real-time progress. Returns the destination path on
    // success so the caller can openTab/openRepo immediately.

    // POST /api/git-clone  { url, dest }
    if (url.pathname === "/api/git-clone" && req.method === "POST") {
      const { url: gitUrl, dest } = await readBody(req);
      const u = (gitUrl || "").trim();
      const d = (dest || "").trim();
      if (!u) return jsonResponse(req, res, { error: "Empty URL" }, 400);
      if (!d) return jsonResponse(req, res, { error: "Empty destination" }, 400);
      const r = spawnSync(GIT, ["clone", u, d], { encoding: "utf-8" });
      if (r.status !== 0) {
        const detail = (r.stderr || r.stdout || "").trim() || "git clone failed";
        return jsonResponse(req, res, { error: detail }, 500);
      }
      return jsonResponse(req, res, { dest: d });
    }

    // POST /api/gh-fork  { url, parentDir }
    if (url.pathname === "/api/gh-fork" && req.method === "POST") {
      const { url: ghUrl, parentDir } = await readBody(req);
      const u = (ghUrl || "").trim();
      const parent = (parentDir || "").trim();
      if (!u) return jsonResponse(req, res, { error: "Empty URL" }, 400);
      if (!parent) return jsonResponse(req, res, { error: "Empty destination" }, 400);
      // Mirror of Rust `repo_name_from_url`: strip trailing slash + .git, then
      // take the last segment after `/` or `:`. Lets us return the final path
      // without parsing gh's stdout (which varies by version + locale).
      const stripped = u.replace(/\/+$/, "").replace(/\.git$/, "");
      const repoName = stripped.split(/[\/:]/).pop();
      if (!repoName) {
        return jsonResponse(req, res, { error: "Could not derive repo name from URL" }, 400);
      }
      const r = spawnSync(
        GH,
        ["repo", "fork", u, "--clone", "--remote-name=upstream"],
        { cwd: resolve(parent), encoding: "utf-8" },
      );
      if (r.status !== 0) {
        const detail = (r.stderr || r.stdout || "").trim() || "gh repo fork failed";
        return jsonResponse(req, res, { error: detail }, 500);
      }
      const finalPath = `${parent.replace(/\/+$/, "")}/${repoName}`;
      return jsonResponse(req, res, { dest: finalPath });
    }

    // GET /api/pr-files?repo=<path>&pr=<number>
    if (url.pathname === "/api/pr-files" && req.method === "GET") {
      const repoPath = url.searchParams.get("repo");
      const prNumber = url.searchParams.get("pr");
      if (!repoPath || !prNumber) {
        return jsonResponse(req, res, { error: "Missing repo or pr parameter" }, 400);
      }
      try {
        const raw = execFileSync(
          GH,
          ["pr", "view", prNumber, "--json", "files", "--jq", "[.files[].path]"],
          { cwd: repoPath, encoding: "utf-8" }
        );
        return jsonResponse(req, res, JSON.parse(raw.trim() || "[]"));
      } catch (err) {
        console.error("[pr-files]", err.message);
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/git-merge-base?cwd=<path>&ref1=<ref>&ref2=<ref>
    // Mirrors the Tauri `git_merge_base` command: returns the SHA of the
    // best common ancestor between ref1 and ref2 (`git merge-base ref1 ref2`).
    if (url.pathname === "/api/git-merge-base" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const ref1 = url.searchParams.get("ref1");
      const ref2 = url.searchParams.get("ref2");
      if (!cwd || !ref1 || !ref2) return jsonResponse(req, res, { error: "Missing cwd, ref1 or ref2" }, 400);
      try {
        const result = spawnSync(GIT, ["merge-base", ref1, ref2], { cwd: resolve(cwd), encoding: "utf-8" });
        if (result.status !== 0) return jsonResponse(req, res, { sha: "" });
        return jsonResponse(req, res, { sha: result.stdout.trim() });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // GET /api/detect-monorepo?cwd=<path>
    // Mirrors the Tauri `detect_monorepo` command (v2.21.0 monorepo scope).
    // Precedence: pnpm > cargo > go.work > nx > turbo > npm/yarn
    // Returns { is_monorepo, manager, packages: [{ name, path, version }] }
    if (url.pathname === "/api/detect-monorepo" && req.method === "GET") {
      const cwdParam = url.searchParams.get("cwd");
      if (!cwdParam) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      let cwdResolved;
      try {
        cwdResolved = realpathSync(resolve(cwdParam));
      } catch {
        return jsonResponse(req, res, { is_monorepo: false, manager: "", packages: [] });
      }

      // Path-traversal guard: cwd must be absolute (already is after resolve).
      // Child reads below all go through safeReadJson / safeReadText which
      // themselves validate paths stay inside cwdResolved.
      function safeReadText(relPath) {
        try {
          const abs = join(cwdResolved, relPath);
          // Validate the abs path stays inside cwd.
          const real = (() => {
            try { return realpathSync(abs); }
            catch {
              // file may not exist yet — canonicalize parent, reassemble
              const parent = dirname(abs);
              try { return join(realpathSync(parent), basename(abs)); }
              catch { return abs; }
            }
          })();
          if (real !== cwdResolved && !real.startsWith(cwdResolved + sep)) return null;
          return readFileSync(real, "utf-8");
        } catch { return null; }
      }

      function safeReadJson(relPath) {
        const text = safeReadText(relPath);
        if (!text) return null;
        try { return JSON.parse(text); } catch { return null; }
      }

      function fileExists(relPath) {
        try {
          const abs = join(cwdResolved, relPath);
          if (abs !== cwdResolved && !abs.startsWith(cwdResolved + sep)) return false;
          return existsSync(abs);
        } catch { return false; }
      }

      // Read name/version from a package.json at relDir
      function pkgMeta(relDir) {
        const pkg = safeReadJson(join(relDir, "package.json").replace(/\\/g, "/"));
        return {
          name: (pkg && pkg.name) ? String(pkg.name) : basename(relDir),
          version: (pkg && pkg.version) ? String(pkg.version) : "",
        };
      }

      // Expand a simple glob pattern like "packages/*" → immediate subdirs that
      // contain a package.json. Only supports single `*` at the last segment.
      function expandGlob(pattern) {
        const noSlash = pattern.replace(/\/\*\*?$/, "").replace(/\*$/, "");
        const baseRel = noSlash.replace(/\\/g, "/");
        const baseAbs = join(cwdResolved, baseRel);
        if (!baseAbs.startsWith(cwdResolved + sep) && baseAbs !== cwdResolved) return [];
        const results = [];
        try {
          const entries = readdirSync(baseAbs, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            const subRel = baseRel ? `${baseRel}/${e.name}` : e.name;
            const pkgJsonAbs = join(baseAbs, e.name, "package.json");
            if (existsSync(pkgJsonAbs)) {
              const meta = pkgMeta(subRel);
              results.push({ name: meta.name, path: subRel, version: meta.version });
            }
          }
        } catch { /* dir missing — return empty */ }
        return results;
      }

      try {
        // ── 1. pnpm ────────────────────────────────────────────────────────
        if (fileExists("pnpm-workspace.yaml")) {
          const content = safeReadText("pnpm-workspace.yaml") || "";
          // Parse only the `packages:` block — stop at the next top-level key.
          // A top-level YAML key is a non-empty line that starts with a word
          // character (not whitespace, not `#`, not `-`).
          const globs = [];
          let inPackages = false;
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "" || trimmed.startsWith("#")) continue;
            // Detect top-level key (no leading whitespace, ends with colon)
            const isTopLevel = /^\w/.test(line) && /:\s*$/.test(trimmed);
            if (isTopLevel) {
              if (/^packages\s*:/.test(trimmed)) { inPackages = true; continue; }
              if (inPackages) break; // hit the next top-level key → done
              inPackages = false;
              continue;
            }
            if (inPackages && trimmed.startsWith("- ")) {
              const pattern = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
              if (pattern) globs.push(pattern);
            }
          }
          const packages = globs.flatMap(expandGlob).sort((a, b) => a.name.localeCompare(b.name));
          return jsonResponse(req, res, { is_monorepo: true, manager: "pnpm", packages });
        }

        // ── 2. Cargo workspace ─────────────────────────────────────────────
        if (fileExists("Cargo.toml")) {
          const content = safeReadText("Cargo.toml") || "";
          if (content.includes("[workspace]")) {
            const packages = findCargoPackages(cwdResolved, content);
            return jsonResponse(req, res, { is_monorepo: true, manager: "cargo", packages });
          }
        }

        // ── 3. go.work ─────────────────────────────────────────────────────
        if (fileExists("go.work")) {
          const content = safeReadText("go.work") || "";
          const packages = findGoPackages(cwdResolved, content);
          return jsonResponse(req, res, { is_monorepo: true, manager: "go", packages });
        }

        // ── 4. nx ──────────────────────────────────────────────────────────
        if (fileExists("nx.json")) {
          const nxContent = safeReadText("nx.json") || "";
          const packages = findNxPackages(cwdResolved, nxContent);
          return jsonResponse(req, res, { is_monorepo: true, manager: "nx", packages });
        }

        // ── 5. turbo ───────────────────────────────────────────────────────
        if (fileExists("turbo.json")) {
          const pkgContent = safeReadText("package.json") || "";
          const packages = extractNpmWorkspacePackages(cwdResolved, pkgContent);
          return jsonResponse(req, res, { is_monorepo: true, manager: "turbo", packages });
        }

        // ── 6. npm / yarn ──────────────────────────────────────────────────
        if (fileExists("package.json")) {
          const pkgContent = safeReadText("package.json") || "";
          if (pkgContent.includes('"workspaces"')) {
            const packages = extractNpmWorkspacePackages(cwdResolved, pkgContent);
            if (packages.length > 0) {
              const manager = fileExists("yarn.lock") ? "yarn" : "npm";
              return jsonResponse(req, res, { is_monorepo: true, manager, packages });
            }
          }
        }

        return jsonResponse(req, res, { is_monorepo: false, manager: "", packages: [] });
      } catch (err) {
        // Never throw — return empty on unexpected error
        console.error("[detect-monorepo] error:", err);
        return jsonResponse(req, res, { is_monorepo: false, manager: "", packages: [] });
      }
    }

    // POST /api/git-branch-merged  { cwd }
    // Mirrors the Tauri `git_branch_merged` command: returns the list of
    // local branches fully merged into the default branch, excluding the
    // current branch and the default branch itself.
    if (url.pathname === "/api/git-branch-merged" && req.method === "POST") {
      const body = await readBody(req);
      const cwd = String(body?.cwd ?? "").trim();
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        // Determine default branch (main or master or first remote HEAD).
        const headRef = spawnSync(GIT, ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: resolve(cwd), encoding: "utf-8" });
        const defaultBranch = headRef.status === 0
          ? headRef.stdout.trim().replace("refs/remotes/origin/", "")
          : "main";
        const currentRef = spawnSync(GIT, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolve(cwd), encoding: "utf-8" });
        const current = currentRef.stdout.trim();
        const result = spawnSync(GIT, ["branch", "--merged", defaultBranch], { cwd: resolve(cwd), encoding: "utf-8" });
        if (result.status !== 0) return jsonResponse(req, res, []);
        const merged = result.stdout
          .split("\n")
          .map((b) => b.replace(/^\*?\s+/, "").trim())
          .filter((b) => b && b !== defaultBranch && b !== current);
        return jsonResponse(req, res, merged);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // ── Terminal PTY (dev echo) ───────────────────────────────────────────────
    if (url.pathname === "/api/terminal-open" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || process.cwd();
      const shell = url.searchParams.get("shell") || process.env.SHELL || "/bin/bash";
      const id = devPtyNextId++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ id })}\n\n`);
      // Shell en mode pipe (pas de vrai PTY en dev — best effort).
      // LF only: no PTY line discipline → convert \n → \r\n so xterm
      // moves the cursor to column 0 (PTY output processing does this normally).
      const proc = spawn(shell, ["-i"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      const send = (buf) => {
        const str = buf.toString().replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
        res.write(`data: ${JSON.stringify({ chunk: str })}\n\n`);
      };
      proc.stdout.on("data", send);
      proc.stderr.on("data", send);
      proc.on("close", () => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ eof: true })}\n\n`);
        devPtys.delete(id);
      });
      devPtys.set(id, { proc, res, send });
      req.on("close", () => { proc.kill(); devPtys.delete(id); });
      return;
    }
    if (url.pathname === "/api/terminal-write" && req.method === "POST") {
      const { id, data } = await readBody(req);
      const pty = devPtys.get(id);
      if (pty) {
        // Simulate PTY echo — the TTY line discipline normally echoes typed
        // chars back to the display. With a pipe there is no line discipline,
        // so we echo manually. Only echo printable ASCII, CR (Enter), and DEL.
        let echo = "";
        for (const ch of data) {
          const code = ch.charCodeAt(0);
          if (ch === "\r") {
            echo += "\r\n";           // Enter → move to next line in xterm
          } else if (ch === "\x7f" || ch === "\x08") {
            echo += "\b \b";          // Backspace / DEL → erase last char
          } else if (code >= 0x20 && code <= 0x7e) {
            echo += ch;               // Printable ASCII — echo as-is
          }
          // Control chars / escape sequences: skip (don't echo to xterm)
        }
        if (echo) pty.send(Buffer.from(echo));
        // Convert CR → LF before writing to bash stdin: without a TTY the
        // line discipline is absent and bash only terminates lines on LF.
        pty.proc.stdin.write(data.replace(/\r/g, "\n"));
      }
      return jsonResponse(req, res, { ok: true });
    }
    if (url.pathname === "/api/terminal-resize" && req.method === "POST") {
      return jsonResponse(req, res, { ok: true }); // pas de winsize en mode pipe
    }
    if (url.pathname === "/api/terminal-close" && req.method === "POST") {
      const { id } = await readBody(req);
      devPtys.get(id)?.proc.kill();
      devPtys.delete(id);
      return jsonResponse(req, res, { ok: true });
    }

    jsonResponse(req, res, { error: "Not found" }, 404);
  } catch (err) {
    jsonResponse(req, res, { error: err.message }, 500);
  }
}

// Bind on loopback only. The dev-server exposes filesystem + git commands,
// so it must never be reachable from other hosts on the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  GitWand Dev Server`);
  console.log(`  http://127.0.0.1:${PORT}\n`);
  console.log(`  \u26A0\uFE0F  DEVELOPMENT ONLY — do not expose publicly.`);
  console.log(`     Bound to 127.0.0.1, CORS restricted to Tauri + Vite dev origins.\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /api/conflicted-files?cwd=<path>`);
  console.log(`    POST /api/read-file   { cwd, path }`);
  console.log(`    POST /api/write-file  { cwd, path, content }`);
  console.log(`    POST /api/read-file-at-revision  { cwd, rev, path }`);
  console.log(`    POST /api/folder-diff  { cwd, refA, refB }`);
  console.log(`    POST /api/read-gitwandrc  { cwd }`);
  console.log(`    POST /api/write-gitwandrc { cwd, content }`);
  console.log(`    GET  /api/list-dir?path=<path>`);
  console.log(`    GET  /api/git-status?cwd=<path>`);
  console.log(`    GET  /api/git-diff?cwd=<path>&path=<file>&staged=<bool>`);
  console.log(`    GET  /api/git-log?cwd=<path>&count=<n>&all=<bool>`);
  console.log(`    GET  /api/gh-list-prs?cwd=<path>&state=<state>`);
  console.log(`    GET  /api/gh-pr-count?cwd=<path>&state=<state>`);
  console.log(`    POST /api/gh-create-pr  { cwd, title, body, base?, draft?, reviewers? }`);
  console.log(`    GET  /api/gh-reviewer-candidates?cwd=<path>`);
  console.log(`    GET  /api/gh-pr-detail?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-pr-diff?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-pr-checks?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-check-annotations?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/pr-files?repo=<path>&pr=<n>`);
  console.log(`    GET  /api/git-remote-info?cwd=<path>`);
  console.log(`    GET  /api/git-merge-base?cwd=<path>&ref1=<ref>&ref2=<ref>`);
  console.log(`    POST /api/git-branch-merged  { cwd }`);
  console.log(`    POST /api/check-remote-reachable  { url, timeoutMs }`);
  console.log(`    GET  /api/detect-monorepo?cwd=<path>\n`);
});

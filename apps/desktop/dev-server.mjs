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
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync, realpathSync, renameSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, basename, sep, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";

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

    // GET /api/git-status?cwd=<path>
    if (url.pathname === "/api/git-status" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync("git status --porcelain=v2 --branch", {
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
              staged.push({ path, status, oldPath: undefined });
            }

            if (unstagedChar !== ".") {
              const status = { M: "modified", D: "deleted" }[unstagedChar] || "modified";
              unstaged.push({ path, status, oldPath: undefined });
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
            const origPath = tabIdx >= 0 ? line.substring(tabIdx + 1) : undefined;

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

        return jsonResponse(req, res, { branch, remote, ahead, behind, staged, unstaged, untracked, conflicted });
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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

    // GET /api/git-log?cwd=<path>&count=<n>&all=<bool>&author=<email>
    if (url.pathname === "/api/git-log" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const count = parseInt(url.searchParams.get("count") || "50");
      // Default: current branch only (like `git log`). Pass `all=true` for all refs.
      const all = url.searchParams.get("all") === "true";
      const author = url.searchParams.get("author") || "";

      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        const format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";
        const args = ["log"];
        if (all) args.push("--all");
        if (author) args.push(`--author=${author}`);
        args.push(`-n${count}`, `--format=${format}`);
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

        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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

    // POST /api/git-push  { cwd, setUpstream? }
    if (url.pathname === "/api/git-push" && req.method === "POST") {
      const { cwd, setUpstream } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const cmd = setUpstream
          ? "git push --set-upstream origin HEAD 2>&1"
          : "git push 2>&1";
        const stdout = execSync(cmd, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: err.stderr || err.message });
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
        return jsonResponse(req, res, { success: false, message: err.stderr || err.message });
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
        return jsonResponse(req, res, { success: false, message: (err.stderr || err.message || "").trim() });
      }
    }

    // POST /api/git-pull  { cwd, rebase? }
    if (url.pathname === "/api/git-pull" && req.method === "POST") {
      const { cwd, rebase } = await readBody(req);
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const cmd = rebase ? "git pull --rebase 2>&1" : "git pull 2>&1";
        const stdout = execSync(cmd, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(req, res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(req, res, { success: false, message: err.stderr || err.message });
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // GET /api/git-branches?cwd=<path>
    if (url.pathname === "/api/git-branches" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const format = "%(HEAD)%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(objectname:short) %(subject)\x1f%(creatordate:iso)";
        const stdout = execSync(`git branch -a --format="${format}"`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });

        const branches = [];
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

          if (name.includes("HEAD ->") || name === "origin/HEAD") continue;

          let ahead = 0, behind = 0;
          for (const part of trackInfo.split(", ")) {
            if (part.startsWith("ahead ")) ahead = parseInt(part.substring(6)) || 0;
            if (part.startsWith("behind ")) behind = parseInt(part.substring(7)) || 0;
          }

          const isRemote = name.startsWith("origin/") || name.startsWith("remotes/");

          branches.push({ name, isCurrent, isRemote, upstream, ahead, behind, lastCommit, lastCommitDate });
        }

        return jsonResponse(req, res, branches);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
          ["stash", "list", "--format=%gd%x09%gs%x09%ct"],
          { cwd: resolvedCwd, encoding: "utf-8" },
        );
        const entries = out
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [ref, message, ts] = line.split("\t");
            const indexMatch = /stash@\{(\d+)\}/.exec(ref ?? "");
            const date = ts ? new Date(parseInt(ts, 10) * 1000).toISOString() : "";
            // `message` looks like "WIP on <branch>: <subject>" or
            // "On <branch>: <subject>" when the user gave a custom label.
            const onMatch = /^(?:WIP )?on ([^:]+):\s*(.*)$/.exec(message ?? "");
            const branch = onMatch ? onMatch[1] : "";
            const subject = onMatch ? onMatch[2] : (message ?? "");
            return {
              index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
              message: subject,
              branch,
              date,
            };
          });
        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // ─── GitHub REST API endpoints (no gh binary needed) ──────

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
        return jsonResponse(req, res, { error: err.message }, 500);
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
          // mergeable_state is the closest REST equivalent to mergeStateStatus.
          merge_state_status: pr.mergeable_state ?? "",
          // statusCheckRollup requires an extra API call per PR — not fetched here.
          checks_rollup: "",
        }));
        return jsonResponse(req, res, prs);
      } catch (err) {
        console.error("[gh-list-prs]", err.message);
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        const nwo = getRepoNwo(resolve(cwd));
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}/reviews`, token);
        if (!resp.ok) return jsonResponse(req, res, { error: `GitHub API ${resp.status}` }, 500);
        const reviews = await resp.json();
        return jsonResponse(req, res, reviews);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/claude-cli-prompt  { prompt, systemPrompt?, cwd?, outputFormat? }
    if (url.pathname === "/api/claude-cli-prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const CLAUDE = resolveBin("claude");
        const fullPrompt = body.systemPrompt && body.systemPrompt.trim()
          ? `# System\n${body.systemPrompt.trim()}\n\n# User\n${(body.prompt || "").trim()}`
          : (body.prompt || "");
        const fmt = body.outputFormat || "text";
        const r = spawnSync(CLAUDE, ["-p", fullPrompt, "--output-format", fmt], {
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/codex-cli-prompt  { prompt, systemPrompt?, cwd? }
    if (url.pathname === "/api/codex-cli-prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const CODEX = resolveBin("codex");
        const fullPrompt = body.systemPrompt && body.systemPrompt.trim()
          ? `# System\n${body.systemPrompt.trim()}\n\n# User\n${(body.prompt || "").trim()}`
          : (body.prompt || "");
        const r = spawnSync(CODEX, ["exec", fullPrompt], {
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
          if (stderr.includes("CONFLICT") || stderr.includes("could not apply")) {
            return jsonResponse(req, res, { ok: true, conflict: true });
          }
          return jsonResponse(req, res, { error: stderr || "Rebase failed" }, 500);
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        console.error("[rebase] Error:", err);
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/workspace-prs-all  { repos: [{ path, name }] }
    if (url.pathname === "/api/workspace-prs-all" && req.method === "POST") {
      try {
        const { repos } = await readBody(req);
        const results = repos.map(repo => {
          try {
            const raw = execSync(
              "gh pr list --state open --json number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,additions,deletions,labels,assignees,reviewRequests,reviewDecision,mergeStateStatus,statusCheckRollup --limit 100",
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
                .map(rr => rr.requestedReviewer?.login)
                .filter(Boolean),
              review_decision: pr.reviewDecision ?? "",
              merge_state_status: pr.mergeStateStatus ?? "",
              checks_rollup: (pr.statusCheckRollup ?? [])
                .map(c => c.conclusion)
                .find(c => !!c) ?? "",
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
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

        const statuses = worktrees.map(wt => {
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: wt.path, encoding: "utf-8" }).trim();
            let ahead = 0, behind = 0;
            try {
              const ab = execSync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: wt.path, encoding: "utf-8" }).trim().split(/\s+/);
              ahead = parseInt(ab[0]) || 0; behind = parseInt(ab[1]) || 0;
            } catch {}
            const modified = execSync("git status --porcelain --untracked-files=no", { cwd: wt.path, encoding: "utf-8" }).trim().split("\n").filter(Boolean).length;
            return { path: wt.path, name: wt.branch || branch, branch, ahead, behind, modified, error: null };
          } catch (e) {
            return { path: wt.path, name: wt.branch || "", branch: "", ahead: 0, behind: 0, modified: 0, error: e.message };
          }
        });
        return jsonResponse(req, res, statuses);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        let isFirst = true;
        for (const line of raw.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current) entries.push(current);
            current = { path: line.slice("worktree ".length), branch: "", head: "", is_main: isFirst, is_locked: false, is_bare: false };
            isFirst = false;
          } else if (current) {
            if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
            else if (line.startsWith("branch ")) {
              const full = line.slice("branch ".length);
              current.branch = full.startsWith("refs/heads/") ? full.slice("refs/heads/".length) : full;
            } else if (line === "bare") current.is_bare = true;
            else if (line.startsWith("locked")) current.is_locked = true;
            else if (line === "detached") current.branch = "(detached HEAD)";
          }
        }
        if (current) entries.push(current);
        return jsonResponse(req, res, entries);
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/git-worktree-add  { cwd, path, branch, new_branch? }
    if (url.pathname === "/api/git-worktree-add" && req.method === "POST") {
      try {
        const { cwd, path: wtPath, branch, new_branch } = await readBody(req);
        const resolvedCwd = resolve(cwd);
        let cmd = `git worktree add "${wtPath}"`;
        if (new_branch) cmd += ` -b "${new_branch}" "${branch}"`;
        else cmd += ` "${branch}"`;
        execSync(cmd, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        const resolvedBranch = new_branch || branch;
        return jsonResponse(req, res, { path: wtPath, branch: resolvedBranch, head: "", is_main: false, is_locked: false, is_bare: false });
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/git-worktree-prune  { cwd }
    if (url.pathname === "/api/git-worktree-prune" && req.method === "POST") {
      try {
        const { cwd } = await readBody(req);
        execSync("git worktree prune", { cwd: resolve(cwd), encoding: "utf-8" });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/git-submodule-init  { cwd }
    if (url.pathname === "/api/git-submodule-init" && req.method === "POST") {
      try {
        const { cwd } = await readBody(req);
        execSync("git submodule init", { cwd: resolve(cwd), encoding: "utf-8" });
        return jsonResponse(req, res, {});
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
    }

    // POST /api/git-submodule-add  { cwd, url, path }
    if (url.pathname === "/api/git-submodule-add" && req.method === "POST") {
      try {
        const { cwd, url: smUrl, path: smPath } = await readBody(req);
        execSync(`git submodule add "${smUrl}" "${smPath}"`, { cwd: resolve(cwd), encoding: "utf-8", shell: true });
        return jsonResponse(req, res, {});
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
        let name = "";
        let remoteUrl = "";
        for (const line of lines) {
          if (!line.includes("(fetch)")) continue;
          const parts = line.split(/\s+/).filter(Boolean);
          if (parts.length < 2) continue;
          name = parts[0];
          remoteUrl = parts[1];
          break;
        }
        if (!remoteUrl) {
          return jsonResponse(req, res, { error: "No remote found" }, 404);
        }
        let provider = "unknown";
        if (remoteUrl.includes("github.com")) provider = "github";
        else if (remoteUrl.includes("gitlab")) provider = "gitlab";
        else if (remoteUrl.includes("bitbucket")) provider = "bitbucket";

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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        return jsonResponse(req, res, { error: err.message }, 500);
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
        execFileSync(GIT, ["push", remote, "--delete", name], { cwd: resolve(cwd) });
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
      const r = spawnSync(GIT, ["shortlog", "-sne", "HEAD"], {
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
        return jsonResponse(req, res, { error: err.message }, 500);
      }
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
  console.log(`    POST /api/gh-create-pr  { cwd, title, body, base?, draft?, reviewers? }`);
  console.log(`    GET  /api/gh-reviewer-candidates?cwd=<path>`);
  console.log(`    GET  /api/gh-pr-detail?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-pr-diff?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-pr-checks?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/pr-files?repo=<path>&pr=<n>`);
  console.log(`    GET  /api/git-remote-info?cwd=<path>\n`);
});

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
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";

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

/** CORS headers for Vite dev server (port 1420) */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // GET /api/conflicted-files?cwd=/path/to/repo
    if (url.pathname === "/api/conflicted-files" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(res, { error: "Missing cwd param" }, 400);

      const resolvedCwd = resolve(cwd);
      try {
        const stdout = execSync("git diff --name-only --diff-filter=U", {
          cwd: resolvedCwd,
          encoding: "utf-8",
        });
        const files = stdout.trim().split("\n").filter(Boolean);
        return jsonResponse(res, { cwd: resolvedCwd, files });
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
        return jsonResponse(res, { cwd: resolvedCwd, files });
      }
    }

    // POST /api/read-file  { cwd, path }
    if (url.pathname === "/api/read-file" && req.method === "POST") {
      const { cwd, path } = await readBody(req);
      const fullPath = join(resolve(cwd), path);
      const content = readFileSync(fullPath, "utf-8");
      return jsonResponse(res, { path, content });
    }

    // POST /api/write-file  { cwd, path, content }
    if (url.pathname === "/api/write-file" && req.method === "POST") {
      const { cwd, path, content } = await readBody(req);
      const fullPath = join(resolve(cwd), path);
      writeFileSync(fullPath, content, "utf-8");
      return jsonResponse(res, { ok: true });
    }

    // GET /api/list-dir?path=/some/dir  — list directories for folder picker
    if (url.pathname === "/api/list-dir" && req.method === "GET") {
      const dirPath = resolve(url.searchParams.get("path") || homedir());
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
              try { statSync(join(dirPath, e.name, ".git")); return true; } catch { return false; }
            })(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const parentDir = dirname(dirPath);
        return jsonResponse(res, {
          current: dirPath,
          parent: parentDir !== dirPath ? parentDir : null,
          home: homedir(),
          dirs,
        });
      } catch (err) {
        return jsonResponse(res, { error: `Cannot read directory: ${err.message}` }, 400);
      }
    }

    // GET /api/git-status?cwd=<path>
    if (url.pathname === "/api/git-status" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(res, { error: "Missing cwd param" }, 400);

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

        return jsonResponse(res, { branch, remote, ahead, behind, staged, unstaged, untracked, conflicted });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/git-diff?cwd=<path>&path=<file>&staged=<bool>
    if (url.pathname === "/api/git-diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const path = url.searchParams.get("path");
      const staged = url.searchParams.get("staged") === "true";

      if (!cwd || !path) return jsonResponse(res, { error: "Missing cwd or path param" }, 400);

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
          return jsonResponse(res, { path, hunks: [], isDirectory: true, newFiles });
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

        return jsonResponse(res, { path, hunks });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/git-log?cwd=<path>&count=<n>&all=<bool>
    if (url.pathname === "/api/git-log" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const count = parseInt(url.searchParams.get("count") || "50");
      // Default: current branch only (like `git log`). Pass `all=true` for all refs.
      const all = url.searchParams.get("all") === "true";

      if (!cwd) return jsonResponse(res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        const format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";
        const args = ["log"];
        if (all) args.push("--all");
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

        return jsonResponse(res, entries);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-stage  { cwd, paths }
    if (url.pathname === "/api/git-stage" && req.method === "POST") {
      const { cwd, paths } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(res, { error: "Missing cwd or paths" }, 400);
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
        return jsonResponse(res, { ok: true });
      } catch (err) {
        const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
        return jsonResponse(res, { error: detail }, 500);
      }
    }

    // POST /api/git-unstage  { cwd, paths }
    if (url.pathname === "/api/git-unstage" && req.method === "POST") {
      const { cwd, paths } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(res, { error: "Missing cwd or paths" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git reset HEAD -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
        return jsonResponse(res, { error: detail }, 500);
      }
    }

    // POST /api/git-stage-patch  { cwd, patch }
    if (url.pathname === "/api/git-stage-patch" && req.method === "POST") {
      const { cwd, patch } = await readBody(req);
      if (!cwd || !patch) return jsonResponse(res, { error: "Missing cwd or patch" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git apply --cached --unidiff-zero -", {
          cwd: resolvedCwd,
          input: patch,
          encoding: "utf-8",
        });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-unstage-patch  { cwd, patch }
    if (url.pathname === "/api/git-unstage-patch" && req.method === "POST") {
      const { cwd, patch } = await readBody(req);
      if (!cwd || !patch) return jsonResponse(res, { error: "Missing cwd or patch" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git apply --cached --reverse --unidiff-zero -", {
          cwd: resolvedCwd,
          input: patch,
          encoding: "utf-8",
        });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-commit  { cwd, message }
    if (url.pathname === "/api/git-commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return jsonResponse(res, { error: "Missing cwd or message" }, 400);
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
        return jsonResponse(res, { hash });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-amend-commit  { cwd, message }
    if (url.pathname === "/api/git-amend-commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return jsonResponse(res, { error: "Missing cwd or message" }, 400);
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
        return jsonResponse(res, { hash });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-push  { cwd, setUpstream? }
    if (url.pathname === "/api/git-push" && req.method === "POST") {
      const { cwd, setUpstream } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
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
        return jsonResponse(res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(res, { success: false, message: err.stderr || err.message });
      }
    }

    // POST /api/git-fetch  { cwd }
    if (url.pathname === "/api/git-fetch" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git fetch --prune 2>&1", {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
          timeout: 15000,
        });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { success: false, message: err.stderr || err.message });
      }
    }

    // POST /api/git-merge  { cwd, branch }
    if (url.pathname === "/api/git-merge" && req.method === "POST") {
      const { cwd, branch } = await readBody(req);
      if (!cwd || !branch) return jsonResponse(res, { success: false, message: "Missing cwd or branch" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync(`git merge "${branch}" 2>&1`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(res, { success: true, message: stdout.trim() || "Merge completed" });
      } catch (err) {
        // Merge conflicts are not fatal — check if it's a conflict vs real error
        const stderr = (err.stderr || "").toString();
        const stdout = (err.stdout || "").toString();
        const combined = stderr + stdout;
        const isConflict = combined.includes("CONFLICT") || combined.includes("Automatic merge failed");
        return jsonResponse(res, {
          success: false,
          conflicts: isConflict,
          message: isConflict ? "Merge conflicts detected" : (stderr || stdout || err.message || "Merge failed").trim(),
        });
      }
    }

    // POST /api/git-merge-continue  { cwd }
    if (url.pathname === "/api/git-merge-continue" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { success: false, message: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync('git -c core.editor=true merge --continue 2>&1', {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
          env: { ...process.env, GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true" },
        });
        return jsonResponse(res, { success: true, message: stdout.trim() || "Merge completed" });
      } catch (err) {
        return jsonResponse(res, { success: false, message: (err.stderr || err.stdout || err.message || "").toString().trim() });
      }
    }

    // POST /api/git-merge-abort  { cwd }
    if (url.pathname === "/api/git-merge-abort" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { success: false, message: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git merge --abort 2>&1", {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(res, { success: true, message: "Merge aborted" });
      } catch (err) {
        return jsonResponse(res, { success: false, message: (err.stderr || err.message || "").trim() });
      }
    }

    // POST /api/git-pull  { cwd, rebase? }
    if (url.pathname === "/api/git-pull" && req.method === "POST") {
      const { cwd, rebase } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const cmd = rebase ? "git pull --rebase 2>&1" : "git pull 2>&1";
        const stdout = execSync(cmd, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(res, { success: false, message: err.stderr || err.message });
      }
    }

    // GET /api/git-file-diff?cwd=<path>&path=<file>&from=<hash>&to=<hash>
    if (url.pathname === "/api/git-file-diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const fromHash = url.searchParams.get("from");
      const toHash = url.searchParams.get("to");
      if (!cwd || !filePath || !fromHash || !toHash) return jsonResponse(res, { error: "Missing params" }, 400);
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
            } else if (!line.startsWith("\\")) {
              const content = line.length > 0 ? line.substring(1) : "";
              currentHunk.lines.push({ type: "context", content, oldLineNo, newLineNo });
              oldLineNo++;
              newLineNo++;
            }
          }
        }
        if (currentHunk) hunks.push(currentHunk);

        return jsonResponse(res, { path: filePath, hunks });
      } catch (err) {
        // Empty diff if identical
        if (err.status === 0 || (err.stdout && err.stdout.trim() === "")) {
          return jsonResponse(res, { path: filePath, hunks: [] });
        }
        return jsonResponse(res, { path: filePath, hunks: [] });
      }
    }

    // POST /api/git-discard  { cwd, paths, untracked? }
    // Pour les fichiers non-suivis (untracked), utiliser git clean -f
    // Pour les fichiers suivis modifiés, utiliser git restore (ou checkout --)
    if (url.pathname === "/api/git-discard" && req.method === "POST") {
      const { cwd, paths, untracked } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(res, { error: "Missing cwd or paths" }, 400);
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
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message, stderr: err.stderr }, 500);
      }
    }

    // POST /api/git-gitignore  { cwd, path }
    // Ajoute le chemin au fichier .gitignore du repo
    if (url.pathname === "/api/git-gitignore" && req.method === "POST") {
      const { cwd, path: filePath } = await readBody(req);
      if (!cwd || !filePath) return jsonResponse(res, { error: "Missing cwd or path" }, 400);
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
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/git-show?cwd=<path>&hash=<commit>
    if (url.pathname === "/api/git-show" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const hash = url.searchParams.get("hash");
      if (!cwd || !hash) return jsonResponse(res, { error: "Missing cwd or hash param" }, 400);

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

        for (const line of stdout.split("\n")) {
          if (line.startsWith("diff --git ")) {
            if (currentHunk) currentHunks.push(currentHunk);
            currentHunk = null;
            if (currentPath) {
              diffs.push({ path: currentPath, hunks: currentHunks });
              currentHunks = [];
            }
            const parts = line.split(" b/");
            currentPath = parts.length >= 2 ? parts[1] : null;
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
            } else if (!line.startsWith("\\")) {
              const content = line.length > 0 ? line.substring(1) : "";
              currentHunk.lines.push({ type: "context", content, oldLineNo, newLineNo });
              oldLineNo++;
              newLineNo++;
            }
          }
        }

        if (currentHunk) currentHunks.push(currentHunk);
        if (currentPath) diffs.push({ path: currentPath, hunks: currentHunks });

        return jsonResponse(res, diffs);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/git-branches?cwd=<path>
    if (url.pathname === "/api/git-branches" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(res, { error: "Missing cwd param" }, 400);
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

        return jsonResponse(res, branches);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-create-branch  { cwd, name, checkout }
    if (url.pathname === "/api/git-create-branch" && req.method === "POST") {
      const { cwd, name, checkout } = await readBody(req);
      if (!cwd || !name) return jsonResponse(res, { error: "Missing cwd or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const cmd = checkout ? `git checkout -b "${name}"` : `git branch "${name}"`;
        execSync(cmd, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-switch-branch  { cwd, name }
    if (url.pathname === "/api/git-switch-branch" && req.method === "POST") {
      const { cwd, name } = await readBody(req);
      if (!cwd || !name) return jsonResponse(res, { error: "Missing cwd or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git checkout "${name}"`, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-delete-branch  { cwd, name, force }
    if (url.pathname === "/api/git-delete-branch" && req.method === "POST") {
      const { cwd, name, force } = await readBody(req);
      if (!cwd || !name) return jsonResponse(res, { error: "Missing cwd or name" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const flag = force ? "-D" : "-d";
        execSync(`git branch ${flag} "${name}"`, { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-stash  { cwd }
    if (url.pathname === "/api/git-stash" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git stash --include-untracked", { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-stash-pop  { cwd }
    if (url.pathname === "/api/git-stash-pop" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync("git stash pop", { cwd: resolvedCwd, encoding: "utf-8", shell: true });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ─── Git blame ────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/git-blame") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      if (!cwd || !filePath) return jsonResponse(res, { error: "cwd and path required" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const raw = execSync(
          `git blame --porcelain -- "${filePath}"`,
          { cwd: resolvedCwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, shell: true },
        );
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
        return jsonResponse(res, blameLines);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ─── Git file log ───────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/git-file-log") {
      const cwd = url.searchParams.get("cwd");
      const filePath = url.searchParams.get("path");
      const count = parseInt(url.searchParams.get("count") || "50", 10);
      if (!cwd || !filePath) return jsonResponse(res, { error: "cwd and path required" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const format = "%H%n%h%n%an%n%aI%n%s%n%b%n---END---";
        const raw = execSync(
          `git log --follow -n ${count} --format="${format}" -- "${filePath}"`,
          { cwd: resolvedCwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, shell: true },
        );
        const entries = [];
        const blocks = raw.split("---END---\n");
        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed) continue;
          const parts = trimmed.split("\n");
          if (parts.length < 5) continue;
          entries.push({
            hashFull: parts[0],
            hash: parts[1],
            author: parts[2],
            date: parts[3],
            message: parts[4],
            body: parts.slice(5).join("\n").trim(),
          });
        }
        return jsonResponse(res, entries);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ─── GitHub REST API endpoints (no gh binary needed) ──────

    // GET /api/gh-list-prs?cwd=<path>&state=<open|closed|all>
    if (url.pathname === "/api/gh-list-prs" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const state = url.searchParams.get("state") || "open";
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token found. Run: gh auth login" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo from git remote origin" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls?state=${state}&per_page=50`, token);
        if (!resp.ok) {
          const text = await resp.text();
          return jsonResponse(res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
        }
        const raw = await resp.json();
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
        }));
        return jsonResponse(res, prs);
      } catch (err) {
        console.error("[gh-list-prs]", err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/gh-pr-detail?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-detail" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!resp.ok) return jsonResponse(res, { error: `GitHub API ${resp.status}` }, 500);
        const pr = await resp.json();
        return jsonResponse(res, {
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
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/gh-pr-diff?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token, "application/vnd.github.v3.diff");
        if (!resp.ok) return jsonResponse(res, { error: `GitHub API ${resp.status}` }, 500);
        const diff = await resp.text();
        return jsonResponse(res, { diff });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/gh-pr-checks?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-checks" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        // Get PR head SHA first
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(res, { error: `GitHub API ${prResp.status}` }, 500);
        const pr = await prResp.json();
        const sha = pr.head?.sha;
        if (!sha) return jsonResponse(res, []);
        // Get check runs for that commit
        const checksResp = await githubFetch(`/repos/${nwo}/commits/${sha}/check-runs?per_page=100`, token);
        if (!checksResp.ok) return jsonResponse(res, { error: `GitHub API ${checksResp.status}` }, 500);
        const data = await checksResp.json();
        return jsonResponse(res, (data.check_runs ?? []).map((c) => ({
          name: c.name,
          state: c.status === "completed" ? c.conclusion : c.status,
          conclusion: c.conclusion ?? "",
          details_url: c.html_url ?? "",
        })));
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ─── PR Review Comments ────────────────────────────────

    // GET /api/gh-pr-comments?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-comments" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        // Fetch all review comments (paginated — up to 200)
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}/comments?per_page=100`, token);
        if (!resp.ok) return jsonResponse(res, { error: `GitHub API ${resp.status}` }, 500);
        const raw = await resp.json();
        return jsonResponse(res, raw.map((c) => ({
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
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/gh-pr-comment  — create or reply
    // Body: { cwd, number, body, path, line, side, start_line?, start_side?, in_reply_to_id? }
    if (url.pathname === "/api/gh-pr-comment" && req.method === "POST") {
      const body = await readBody(req);
      const { cwd, number, body: commentBody, path: filePath, line, side, start_line, start_side, in_reply_to_id } = body;
      if (!cwd || !number || !commentBody) return jsonResponse(res, { error: "Missing required fields" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        // Get PR head commit SHA
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(res, { error: `GitHub API ${prResp.status}` }, 500);
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
          return jsonResponse(res, { error: `GitHub API ${resp.status}: ${text}` }, 500);
        }
        const c = await resp.json();
        return jsonResponse(res, {
          id: c.id, body: c.body, author: c.user?.login ?? "",
          created_at: c.created_at, updated_at: c.updated_at,
          path: c.path, line: c.line ?? null, original_line: c.original_line ?? null,
          side: c.side ?? "RIGHT", start_line: c.start_line ?? null, start_side: c.start_side ?? null,
          in_reply_to_id: c.in_reply_to_id ?? null, diff_hunk: c.diff_hunk ?? "", url: c.html_url ?? "",
        });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // PATCH /api/gh-pr-comment?id=<n>  — edit comment body
    // Body: { cwd, body }
    if (url.pathname === "/api/gh-pr-comment" && req.method === "PATCH") {
      const id = url.searchParams.get("id");
      const body = await readBody(req);
      const { cwd, body: newBody } = body;
      if (!id || !cwd || !newBody) return jsonResponse(res, { error: "Missing id, cwd or body" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
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
        if (!resp.ok) return jsonResponse(res, { error: `GitHub API ${resp.status}` }, 500);
        const c = await resp.json();
        return jsonResponse(res, { id: c.id, body: c.body, updated_at: c.updated_at });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // DELETE /api/gh-pr-comment?cwd=<path>&id=<n>
    if (url.pathname === "/api/gh-pr-comment" && req.method === "DELETE") {
      const cwd = url.searchParams.get("cwd");
      const id = url.searchParams.get("id");
      if (!cwd || !id) return jsonResponse(res, { error: "Missing cwd or id" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await fetch(`https://api.github.com/repos/${nwo}/pulls/comments/${id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!resp.ok && resp.status !== 204) return jsonResponse(res, { error: `GitHub API ${resp.status}` }, 500);
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ─── PR Reviews ────────────────────────────────────────

    // GET /api/gh-pr-reviews?cwd=<path>&number=<n>
    if (url.pathname === "/api/gh-pr-reviews" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
        const resp = await githubFetch(`/repos/${nwo}/pulls/${number}/reviews`, token);
        if (!resp.ok) return jsonResponse(res, { error: `GitHub API ${resp.status}` }, 500);
        const reviews = await resp.json();
        return jsonResponse(res, reviews);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/gh-pr-submit-review
    // Body: { cwd, number, event, body, comments? }
    // event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
    // comments: [{ path, line, side, start_line?, start_side?, body }]
    if (url.pathname === "/api/gh-pr-submit-review" && req.method === "POST") {
      const body = await readBody(req);
      const { cwd, number, event: reviewEvent, body: reviewBody, comments = [] } = body;
      if (!cwd || !number || !reviewEvent) return jsonResponse(res, { error: "Missing cwd, number, or event" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);

        // Get PR head SHA (required by GitHub API)
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(res, { error: `GitHub API ${prResp.status}` }, 500);
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
          return jsonResponse(res, { error: errBody.message || `GitHub API ${resp.status}` }, 500);
        }
        const review = await resp.json();
        return jsonResponse(res, review);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ─── Phase 9.4 Intelligence ────────────────────────────

    // GET /api/gh-pr-conflict-preview?cwd=<path>&number=<n>
    // Fetches PR head via git fetch, then runs git merge-tree to detect conflicts
    // without touching the working tree.
    if (url.pathname === "/api/gh-pr-conflict-preview" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const number = url.searchParams.get("number");
      if (!cwd || !number) return jsonResponse(res, { error: "Missing cwd or number" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);

        // Get PR base branch + head SHA from GitHub API
        const prResp = await githubFetch(`/repos/${nwo}/pulls/${number}`, token);
        if (!prResp.ok) return jsonResponse(res, { error: `GitHub API ${prResp.status}` }, 500);
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
        if (mbRes.status !== 0) return jsonResponse(res, { error: "Cannot find merge-base" }, 500);
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

        return jsonResponse(res, {
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
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/gh-pr-hotspots?cwd=<path>&paths=file1,file2,...
    // For each file path, count merge commits that touched it — "conflict hotspot" score.
    if (url.pathname === "/api/gh-pr-hotspots" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const pathsParam = url.searchParams.get("paths");
      if (!cwd || !pathsParam) return jsonResponse(res, { error: "Missing cwd or paths" }, 400);
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
        return jsonResponse(res, hotspots);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/git-file-count?cwd=<path>
    // Returns total number of tracked files in the repo.
    if (url.pathname === "/api/git-file-count" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const r = spawnSync(GIT, ["ls-files", "--cached"], { cwd: resolve(cwd), encoding: "utf-8" });
        const count = (r.stdout || "").trim().split("\n").filter(Boolean).length;
        return jsonResponse(res, { count });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /api/gh-pr-file-history?cwd=<path>&paths=file1,file2,...
    // For each file, fetch the last 3 closed PRs that touched it + their review comments.
    if (url.pathname === "/api/gh-pr-file-history" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const pathsParam = url.searchParams.get("paths");
      if (!cwd || !pathsParam) return jsonResponse(res, { error: "Missing cwd or paths" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(res, { error: "No GitHub token" }, 401);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(res, { error: "Could not determine GitHub repo" }, 400);
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
        return jsonResponse(res, result);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
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
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    jsonResponse(res, { error: "Not found" }, 404);
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  GitWand Dev Server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /api/conflicted-files?cwd=<path>`);
  console.log(`    POST /api/read-file   { cwd, path }`);
  console.log(`    POST /api/write-file  { cwd, path, content }`);
  console.log(`    POST /api/read-gitwandrc  { cwd }`);
  console.log(`    GET  /api/list-dir?path=<path>`);
  console.log(`    GET  /api/git-status?cwd=<path>`);
  console.log(`    GET  /api/git-diff?cwd=<path>&path=<file>&staged=<bool>`);
  console.log(`    GET  /api/git-log?cwd=<path>&count=<n>&all=<bool>`);
  console.log(`    GET  /api/gh-list-prs?cwd=<path>&state=<state>`);
  console.log(`    GET  /api/gh-pr-detail?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-pr-diff?cwd=<path>&number=<n>`);
  console.log(`    GET  /api/gh-pr-checks?cwd=<path>&number=<n>\n`);
});

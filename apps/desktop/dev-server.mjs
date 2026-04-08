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
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";

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
            // conflicted
            const parts = line.split("\t");
            if (parts.length >= 2) {
              conflicted.push(parts[1]);
            }
          } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
            // regular file
            const parts = line.split("\t");
            if (parts.length < 2) continue;
            const path = parts[1];
            const meta = parts[0].split(/\s+/);
            if (meta.length < 2) continue;

            const xy = meta[1];
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
        const args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
        const stdout = execSync(`git ${args.join(" ")}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });

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

    // GET /api/git-log?cwd=<path>&count=<n>
    if (url.pathname === "/api/git-log" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const count = parseInt(url.searchParams.get("count") || "50");

      if (!cwd) return jsonResponse(res, { error: "Missing cwd param" }, 400);

      try {
        const resolvedCwd = resolve(cwd);
        const format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";
        const stdout = execSync(`git log -n${count} --format="${format}"`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });

        const entries = [];
        const records = stdout.split("\x1e");
        for (const record of records) {
          const trimmed = record.trim();
          if (!trimmed) continue;
          const fields = trimmed.split("\x1f");
          if (fields.length < 7) continue;

          entries.push({
            hash: fields[0],
            hashFull: fields[1],
            author: fields[2],
            email: fields[3],
            date: fields[4],
            message: fields[5],
            body: fields[6].trim(),
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
        execSync(`git add -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(res, { ok: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
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
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /api/git-commit  { cwd, message }
    if (url.pathname === "/api/git-commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return jsonResponse(res, { error: "Missing cwd or message" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git commit -m ${JSON.stringify(message)}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
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

    // POST /api/git-push  { cwd }
    if (url.pathname === "/api/git-push" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync("git push 2>&1", {
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
          message: isConflict ? "Merge conflicts detected" : (stderr || stdout || err.message || "Merge failed").trim(),
        });
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

    // POST /api/git-pull  { cwd }
    if (url.pathname === "/api/git-pull" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return jsonResponse(res, { error: "Missing cwd" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        const stdout = execSync("git pull 2>&1", {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
        return jsonResponse(res, { success: true, message: stdout.trim() });
      } catch (err) {
        return jsonResponse(res, { success: false, message: err.stderr || err.message });
      }
    }

    // POST /api/git-discard  { cwd, paths }
    if (url.pathname === "/api/git-discard" && req.method === "POST") {
      const { cwd, paths } = await readBody(req);
      if (!cwd || !paths) return jsonResponse(res, { error: "Missing cwd or paths" }, 400);
      try {
        const resolvedCwd = resolve(cwd);
        execSync(`git checkout -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });
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
        const stdout = execSync(`git show --format= "${hash}"`, {
          cwd: resolvedCwd,
          encoding: "utf-8",
          shell: true,
        });

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
        const format = "%(HEAD)%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(objectname:short) %(subject)";
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
          if (parts.length < 3) continue;

          const name = parts[0];
          const upstream = parts[1] || null;
          const trackInfo = parts[2] || "";
          const lastCommit = parts[3] || "";

          if (name.includes("HEAD ->") || name === "origin/HEAD") continue;

          let ahead = 0, behind = 0;
          for (const part of trackInfo.split(", ")) {
            if (part.startsWith("ahead ")) ahead = parseInt(part.substring(6)) || 0;
            if (part.startsWith("behind ")) behind = parseInt(part.substring(7)) || 0;
          }

          const isRemote = name.startsWith("origin/") || name.startsWith("remotes/");

          branches.push({ name, isCurrent, isRemote, upstream, ahead, behind, lastCommit });
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
  console.log(`    GET  /api/list-dir?path=<path>`);
  console.log(`    GET  /api/git-status?cwd=<path>`);
  console.log(`    GET  /api/git-diff?cwd=<path>&path=<file>&staged=<bool>`);
  console.log(`    GET  /api/git-log?cwd=<path>&count=<n>\n`);
});

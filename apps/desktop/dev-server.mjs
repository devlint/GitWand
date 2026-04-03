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
  console.log(`    GET  /api/list-dir?path=<path>\n`);
});

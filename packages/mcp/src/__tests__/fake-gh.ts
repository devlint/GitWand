/**
 * A fake `gh` (and `ssh`) for the gitwand_create_issue tests (#301): an
 * executable that records each call (tool, argv, stdin) in `calls.jsonl` next
 * to it and answers from `answers.json` — keyed by `api`, `issue create` or
 * `ssh`. Tests put its
 * directory first on PATH. Node runs it (its absolute path in the shebang),
 * so it needs nothing else on PATH.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

export interface FakeAnswer {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Wait this long before answering (a slow network). */
  sleepMs?: number;
  /** Kill itself with this signal instead of answering. */
  signal?: string;
}

export interface FakeCall {
  tool: "gh" | "ssh";
  argv: string[];
  stdin: string | null;
}

const SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const tool = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const key = tool === "ssh" ? "ssh" : argv[0] === "api" ? "api" : argv.slice(0, 2).join(" ");
const stdin = argv.includes("--body-file") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ tool, argv, stdin }) + "\\n");
const answers = JSON.parse(fs.readFileSync(path.join(dir, "answers.json"), "utf8"));
const a = answers[key] || { stderr: "fake " + tool + ": no answer for " + key, code: 1 };
const answer = () => {
  if (a.signal) process.kill(process.pid, a.signal);
  if (a.stdout) process.stdout.write(a.stdout);
  if (a.stderr) process.stderr.write(a.stderr);
  process.exit(a.code || 0);
};
if (a.sleepMs) setTimeout(answer, a.sleepMs);
else answer();
`;

export class FakeGh {
  readonly dir: string;
  private savedPath: string | undefined;

  constructor(answers: Record<string, FakeAnswer>) {
    this.dir = mkdtempSync(join(tmpdir(), "gitwand-fake-gh-"));
    // `.cjs` body behind a tiny launcher: `gh` itself has no extension.
    writeFileSync(join(this.dir, "gh.cjs"), SCRIPT);
    // `ssh` too (for `ssh -G` alias lookups), answering under the key "ssh".
    for (const name of ["gh", "ssh"]) {
      writeFileSync(join(this.dir, name), `#!${process.execPath}\nrequire(${JSON.stringify(join(this.dir, "gh.cjs"))});\n`);
      chmodSync(join(this.dir, name), 0o755);
    }
    this.answer(answers);
    this.savedPath = process.env.PATH;
    process.env.PATH = `${this.dir}:${process.env.PATH ?? ""}`;
  }

  /** A `git` first on PATH that waits `ms` before running the real one. */
  slowGit(ms: number): void {
    const real = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim() + "/git";
    writeFileSync(
      join(this.dir, "git"),
      `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst t = Date.now(); while (Date.now() - t < ${ms});\nconst r = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`,
    );
    chmodSync(join(this.dir, "git"), 0o755);
  }

  answer(answers: Record<string, FakeAnswer>): void {
    writeFileSync(join(this.dir, "answers.json"), JSON.stringify(answers));
  }

  calls(): FakeCall[] {
    const p = join(this.dir, "calls.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  dispose(): void {
    process.env.PATH = this.savedPath;
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A `GET /repos/{o}/{r}` answer as GitHub shapes it (the fields the tool reads). */
export function repoJson(
  fullName: string,
  opts: { hasIssues?: boolean; archived?: boolean; parent?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const j: Record<string, unknown> = {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    has_issues: opts.hasIssues ?? true,
    archived: opts.archived ?? false,
    fork: opts.parent !== undefined,
  };
  if (opts.parent) j.parent = opts.parent;
  return j;
}

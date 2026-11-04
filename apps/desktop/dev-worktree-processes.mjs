/**
 * v3.13 — dev-server mirror of `worktree_processes.rs` (`worktree_stop_processes`),
 * for manual QA in `pnpm dev:web`. Best effort, as far as Node allows:
 *
 * - the same refusal: only a linked worktree of the repo, never the main one;
 * - the dev-server's own terminals in the worktree are killed first;
 * - after 500 ms, the processes whose cwd is inside the worktree are swept
 *   (`ps` + `lsof` on macOS, `/proc` on Linux). "Owned" means a descendant of
 *   a closed terminal or of the dev-server itself: Node has no `getsid`, so a
 *   background job reparented away is listed as foreign here, unlike in Rust;
 * - owned ones get SIGTERM, then SIGKILL after 2 s; the others only when
 *   `killForeign` is set.
 *
 * Every subprocess runs through `execFile` with an argument array.
 */
import { execFile } from "node:child_process";
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SWEEP_DELAY_MS = 500;
const KILL_AFTER_MS = 2000;

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const realOrNull = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

async function linkedWorktree(repo, worktree) {
  const refuse = () => new Error(`Not a linked worktree of this repository: ${worktree}`);
  const canon = realOrNull(worktree);
  if (!canon) throw refuse();
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  const linked = stdout
    .split("\n\n")
    .slice(1)
    .map((block) => block.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length))
    .filter(Boolean)
    .map(realOrNull);
  if (!linked.includes(canon)) throw refuse();
  return canon;
}

async function listProcesses() {
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/))
      .filter(Boolean)
      .map(([, pid, ppid, name]) => ({ pid: Number(pid), ppid: Number(ppid), name: name.trim() }));
  } catch {
    return [];
  }
}

async function pidsWithCwdUnder(root) {
  const pairs = [];
  if (process.platform === "darwin") {
    let stdout = "";
    try {
      ({ stdout } = await run("lsof", ["-a", "-d", "cwd", "-F", "pn"], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      stdout = e.stdout ?? ""; // lsof exits 1 when some processes are unreadable
    }
    let pid = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid !== null) pairs.push([pid, line.slice(1)]);
    }
  } else if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        pairs.push([Number(name), readlinkSync(`/proc/${name}/cwd`)]);
      } catch {
        /* unreadable: skipped */
      }
    }
  }
  const pids = new Set();
  for (const [pid, cwd] of pairs) {
    const real = realOrNull(cwd);
    if (real && under(real, root)) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/** `pid` and its ancestors (the shell, pnpm… the dev-server was started from). */
export function devSelfAndAncestors(pid, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = new Set([pid]);
  let cur = pid;
  for (;;) {
    const p = byPid.get(cur);
    if (!p || p.ppid <= 1 || chain.has(p.ppid)) return chain;
    chain.add(p.ppid);
    cur = p.ppid;
  }
}

function isDescendant(pid, ancestors, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set();
  let cur = pid;
  for (;;) {
    if (ancestors.has(cur)) return true;
    if (cur <= 1 || seen.has(cur)) return false;
    seen.add(cur);
    const p = byPid.get(cur);
    if (!p) return false;
    cur = p.ppid;
  }
}

/**
 * Stops what runs in `worktree`, a linked worktree of `repo`. `devPtys` is the
 * dev-server's terminal map (id → { proc, cwd }). Resolves to what still runs there.
 */
export async function devStopProcessesIn(repo, worktree, killForeign, devPtys) {
  const root = await linkedWorktree(repo, worktree);
  const own = new Set([process.pid]);
  for (const [id, entry] of devPtys) {
    if (entry.cwd && under(entry.cwd, root)) {
      own.add(entry.proc.pid);
      try {
        entry.proc.kill();
      } catch {
        /* already gone */
      }
      devPtys.delete(id);
    }
  }
  await sleep(SWEEP_DELAY_MS);

  const procs = await listProcesses();
  const spared = devSelfAndAncestors(process.pid, procs);
  const targets = (await pidsWithCwdUnder(root)).filter(
    (pid) => pid > 1 && !spared.has(pid) && (killForeign || isDescendant(pid, own, procs)),
  );
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone or not ours */
    }
  }
  let left = targets;
  const deadline = Date.now() + KILL_AFTER_MS;
  while (left.length && Date.now() < deadline) {
    await sleep(50);
    left = left.filter(alive);
  }
  for (const pid of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  if (left.length) await sleep(100);

  const after = await listProcesses();
  return (await pidsWithCwdUnder(root))
    .filter((pid) => pid > 1 && !spared.has(pid))
    .map((pid) => after.find((p) => p.pid === pid) ?? { pid, ppid: 0, name: "?" });
}

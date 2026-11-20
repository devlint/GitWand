/**
 * Running a program without blocking the MCP server's event loop (the
 * server keeps answering other requests meanwhile): array args, no shell,
 * `input` on stdin, a time limit enforced to the end (SIGTERM, then SIGKILL,
 * then giving up on the child), output capped. Never rejects.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface RunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  /** Between SIGTERM and SIGKILL, and between SIGKILL and giving up. Default 2 s. */
  killGraceMs?: number;
  /** stdout + stderr beyond this stop the child. Default 16 MiB. */
  maxOutputBytes?: number;
}

export interface Ran {
  /** The program could not be started: not installed (ENOENT). */
  missing: boolean;
  /** Stopped for taking longer than `timeoutMs`. */
  timedOut: boolean;
  /** Stopped for writing more than `maxOutputBytes`. */
  capped: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: RunOptions): Promise<Ran> {
  const grace = opts.killGraceMs ?? 2_000;
  const cap = opts.maxOutputBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let capped = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const done = (r: { missing: boolean; code: number | null; signal: NodeJS.Signals | null; note?: string }) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      if (r.note) err.push(Buffer.from(r.note));
      resolve({
        missing: r.missing,
        timedOut,
        capped,
        code: r.code,
        signal: r.signal,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      // An argument spawn refuses outright (a NUL byte): not run at all.
      done({ missing: false, code: null, signal: null, note: (e as Error).message });
      return;
    }

    /** SIGTERM, SIGKILL if it lingers, and stop waiting if even that does not end it. */
    const stop = () => {
      child.kill("SIGTERM");
      timers.push(
        setTimeout(() => {
          child.kill("SIGKILL");
          timers.push(setTimeout(() => done({ missing: false, code: null, signal: "SIGKILL" }), grace));
        }, grace),
      );
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs),
    );
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (capped) return;
      size += chunk.length;
      if (size > cap) {
        capped = true;
        stop();
      } else {
        into.push(chunk);
      }
    };
    child.stdout!.on("data", collect(out));
    child.stderr!.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) => {
      // spawn says ENOENT for a missing working directory too.
      if (e.code === "ENOENT" && opts.cwd && !existsSync(opts.cwd)) {
        done({ missing: false, code: null, signal: null, note: `The directory ${opts.cwd} no longer exists.` });
      } else {
        done({ missing: e.code === "ENOENT", code: null, signal: null, note: e.code === "ENOENT" ? undefined : e.message });
      }
    });
    child.on("close", (code, signal) => done({ missing: false, code, signal }));
    // A child that exits before reading stdin must not crash the server.
    child.stdin!.on("error", () => {});
    child.stdin!.end(opts.input ?? "");
  });
}

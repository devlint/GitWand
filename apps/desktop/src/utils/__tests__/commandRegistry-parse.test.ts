/**
 * The parser behind the command-route guard.
 *
 * It exists as its own unit because the guard is worthless if it under-counts:
 * a guard that misses an invocation passes while the audit it claims to
 * perform is incomplete. The nested-generic case below is not hypothetical —
 * it is how `git_status`, `git_diff`, `git_log` and `git_blame` escaped the
 * first measurement (design §1).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  findInvokedCommands,
  findDevServerRoutes,
} from "../commandRegistryParse";

describe("findInvokedCommands", () => {
  it("finds a plain invocation", () => {
    const src = `await tauriInvoke("git_status", { cwd });`;
    expect(findInvokedCommands(src).commands).toEqual(["git_status"]);
  });

  it("finds one behind a simple type parameter", () => {
    const src = `return tauriInvoke<string>("git_show", { cwd });`;
    expect(findInvokedCommands(src).commands).toEqual(["git_show"]);
  });

  it("finds one behind a nested generic", () => {
    // The regression that motivated this parser.
    const src = `return tauriInvoke<Array<{ hash_full: string; hash: string }>>("git_log", { cwd });`;
    expect(findInvokedCommands(src).commands).toEqual(["git_log"]);
  });

  it("ignores the declaration of tauriInvoke itself", () => {
    const src = `export async function tauriInvoke<T>(cmd: string, args?: X): Promise<T> {}`;
    expect(findInvokedCommands(src).commands).toEqual([]);
    expect(findInvokedCommands(src).dynamic).toEqual([]);
  });

  it("ignores a mention inside a comment", () => {
    // backend-core.ts really contains this line.
    const src = ` * Timeout presets for tauriInvoke.`;
    expect(findInvokedCommands(src).commands).toEqual([]);
    expect(findInvokedCommands(src).dynamic).toEqual([]);
  });

  it("ignores an import", () => {
    const src = `import { isTauri, tauriInvoke, devFetch } from './backend-core';`;
    expect(findInvokedCommands(src).commands).toEqual([]);
    expect(findInvokedCommands(src).dynamic).toEqual([]);
  });

  it("reports an invocation whose name is not a string literal", () => {
    const src = `await tauriInvoke(commandName, { cwd });`;
    const res = findInvokedCommands(src);
    expect(res.commands).toEqual([]);
    expect(res.dynamic).toHaveLength(1);
    expect(res.dynamic[0]).toContain("commandName");
  });

  it("deduplicates and sorts", () => {
    const src = `tauriInvoke("git_status", {}); tauriInvoke("git_blame", {}); tauriInvoke("git_status", {});`;
    expect(findInvokedCommands(src).commands).toEqual([
      "git_blame",
      "git_status",
    ]);
  });
});

describe("findDevServerRoutes", () => {
  it("finds a route declaration", () => {
    const src = `if (url.pathname === "/api/git-status" && req.method === "GET") {`;
    expect(findDevServerRoutes(src)).toEqual(["/api/git-status"]);
  });

  it("deduplicates a route declared for two methods", () => {
    const src = `url.pathname === "/api/git-stash"\nurl.pathname === "/api/git-stash"`;
    expect(findDevServerRoutes(src)).toEqual(["/api/git-stash"]);
  });
});

describe("the parser against the real sources", () => {
  const root = resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

  it("finds at least as many invocations as the design measured", () => {
    // A floor, not an equality: commands get added, and this test should not
    // fail for that. What it catches is the parser regressing — the first
    // measurement said 122 because a regex stopped at the first `>`, and a
    // guard that under-counts passes while auditing nothing (design §1).
    const src =
      read("src/utils/backend.ts") + "\n" + read("src/utils/backend-core.ts");
    const { commands, dynamic } = findInvokedCommands(src);
    expect(commands.length).toBeGreaterThanOrEqual(139);
    expect(dynamic).toEqual([]);
  });

  it("finds at least as many routes as the design measured", () => {
    expect(
      findDevServerRoutes(read("dev-server.mjs")).length,
    ).toBeGreaterThanOrEqual(169);
  });
});

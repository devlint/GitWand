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
  findRegisteredCommands,
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

  it("finds a case label inside a prefix dispatcher", () => {
    // How dev-server.mjs declares the Gitea read routes.
    const src = `if (url.pathname.startsWith("/api/gitea-")) {\n  switch (url.pathname) {\n    case "/api/gitea-list-prs": {`;
    expect(findDevServerRoutes(src)).toEqual(["/api/gitea-list-prs"]);
  });

  it("ignores a case label its dispatcher's prefix can never reach", () => {
    // `/api/bb-list-prs` cannot get past a `/api/gitea-` guard: unreachable.
    const src = `if (url.pathname.startsWith("/api/gitea-")) {\n  switch (url.pathname) {\n    case "/api/gitea-get-pr": { break; }\n    case "/api/bb-list-prs": { break; }\n  }\n}`;
    expect(findDevServerRoutes(src)).toEqual(["/api/gitea-get-pr"]);
  });

  it("ignores a case label outside any dispatcher block", () => {
    const src = `if (url.pathname.startsWith("/api/gitea-")) {\n  switch (url.pathname) {\n    case "/api/gitea-get-pr": { break; }\n  }\n}\nswitch (x) {\n  case "/api/gitea-orphan": break;\n}`;
    expect(findDevServerRoutes(src)).toEqual(["/api/gitea-get-pr"]);
  });
});

describe("findRegisteredCommands", () => {
  it("takes the last segment of each path-qualified entry", () => {
    const src = `.invoke_handler(tauri::generate_handler![\n  commands::read::git_log,\n  commands::ops::git_merge,\n  plain_cmd\n])`;
    expect(findRegisteredCommands(src)).toEqual(["git_log", "git_merge", "plain_cmd"]);
  });

  it("does not count a commented-out entry", () => {
    const src = `generate_handler![\n  // ── Section ──\n  commands::a::kept,\n  // commands::a::dropped,\n  /* commands::a::also_dropped, */\n]`;
    expect(findRegisteredCommands(src)).toEqual(["kept"]);
  });

  it("skips an attribute but keeps the command it gates", () => {
    const src = `generate_handler![\n  #[cfg(target_os = "macos")]\n  commands::a::mac_only,\n  commands::a::everywhere,\n]`;
    expect(findRegisteredCommands(src)).toEqual(["everywhere", "mac_only"]);
  });

  it("stops at the macro's closing bracket", () => {
    const src = `generate_handler![commands::a::inside])\nlet v = vec![outside];`;
    expect(findRegisteredCommands(src)).toEqual(["inside"]);
  });

  it("is not fooled by comment markers inside a string above the macro", () => {
    // `/*` in "src/*.rs" is not a comment opener: a naive strip would eat
    // everything up to the next `*/`, macro included.
    const src = `const GLOB: &str = "src/*.rs";\nlet url = "https://x";\ngenerate_handler![\n  commands::a::kept,\n]\n// later */`;
    expect(findRegisteredCommands(src)).toEqual(["kept"]);
  });

  it("ignores the macro's name mentioned in a comment or a string", () => {
    const src = `// see generate_handler![commands::a::in_comment]\nlet s = "generate_handler![in_string]";\ngenerate_handler![commands::a::real]`;
    expect(findRegisteredCommands(src)).toEqual(["real"]);
  });

  it("skips an attribute whose arguments contain brackets", () => {
    const src = `generate_handler![\n  #[cfg_attr(feature = "x", doc = "a [b] c")]\n  #[my_attr(list[0], nested[[1]])]\n  commands::a::gated,\n  commands::a::plain,\n]`;
    expect(findRegisteredCommands(src)).toEqual(["gated", "plain"]);
  });

  it("does not take a lifetime for a char literal", () => {
    const src = `fn f<'a>(x: &'a str) -> char { '[' }\ngenerate_handler![commands::a::kept]`;
    expect(findRegisteredCommands(src)).toEqual(["kept"]);
  });

  it("lexes raw strings, escaped quotes and astral chars without losing the macro", () => {
    const src = [
      `let a = r#"has "quotes" and /* and generate_handler![x]"#;`,
      `let b = br"/*";`,
      `let c = '\\''; let d = '\\u{1F600}'; let e = '😀'; let f = "esc \\" /*";`,
      `generate_handler![commands::a::kept, #![inner] commands::a::also]`,
    ].join("\n");
    expect(findRegisteredCommands(src)).toEqual(["also", "kept"]);
  });

  it("returns nothing when there is no macro", () => {
    expect(findRegisteredCommands("fn main() {}")).toEqual([]);
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

  it("finds at least as many registered commands as lib.rs held when this was written", () => {
    // 305 on 2026-10-14. A floor: a parser that stopped at the first comment
    // or attribute would make "every invoked command is registered" vacuous.
    expect(
      findRegisteredCommands(read("src-tauri/src/lib.rs")).length,
    ).toBeGreaterThanOrEqual(305);
  });
});

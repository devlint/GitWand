/**
 * GitWand's own repository is named in three places (the form, the Rust
 * command, the dev-server): a rename must not leave one behind (#301).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GITWAND_REPO } from "../composables/useCreateIssue";
// @ts-expect-error — plain .mjs module, no type declarations
import { GITWAND_REPO as DEV_REPO } from "../../dev-issues.mjs";

describe("GITWAND_REPO", () => {
  it("is the same in TypeScript, Rust and the dev-server", () => {
    const rust = readFileSync(join(__dirname, "../../src-tauri/src/commands/gh_issues.rs"), "utf8");
    const m = /pub\(crate\) const GITWAND_REPO: &str = "([^"]+)";/.exec(rust);
    expect(m?.[1]).toBe(GITWAND_REPO);
    expect(DEV_REPO).toBe(GITWAND_REPO);
  });

  it("is never written by hand in the public warning (it takes it as a parameter)", () => {
    for (const loc of ["en", "fr", "es", "pt-BR", "zh-CN"]) {
      const text = readFileSync(join(__dirname, `../locales/${loc}.ts`), "utf8");
      const warning = /publicWarning: "([^"]*)"/.exec(text)?.[1] ?? "";
      expect(warning.includes(GITWAND_REPO), loc).toBe(false);
      expect(warning.includes("{0}"), loc).toBe(true);
    }
  });
});

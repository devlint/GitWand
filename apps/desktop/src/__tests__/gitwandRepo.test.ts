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
});

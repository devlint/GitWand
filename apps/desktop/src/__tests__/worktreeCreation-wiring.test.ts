/**
 * v3.13 PR 3 — Both creation paths go through the worktree service
 * (`useWorktreeCreation` → `worktree_create`), never the old commands, and
 * App.vue registers the setup-tab runner the composable needs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");
const appVue = read("../App.vue");
const manager = read("../components/WorktreeManager.vue");

describe("worktree creation wiring", () => {
  it("App.vue creates AI tasks through useWorktreeCreation and registers the setup runner", () => {
    expect(appVue).toMatch(/useWorktreeCreation\(\)/);
    expect(appVue).toMatch(/registerSetupRunner\(/);
    expect(appVue).toMatch(/worktreeRunHook\(/);
    expect(appVue).not.toMatch(/scratchWorktreeCreate\(/);
  });

  it("WorktreeManager creates through useWorktreeCreation, never gitWorktreeAdd", () => {
    expect(manager).toMatch(/useWorktreeCreation\(\)/);
    expect(manager).not.toMatch(/gitWorktreeAdd\(/);
    expect(manager).toMatch(/kind: "manual"/);
  });
});

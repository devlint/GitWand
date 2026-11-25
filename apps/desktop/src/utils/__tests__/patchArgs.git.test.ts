import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchDiffArgs, patchShowArgs } from "../patchArgs";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@t.test",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@t.test",
};
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf-8" });

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("patchDiffArgs", () => {
  // What Commit Review and the AI prompts read: the same patch whatever the
  // user's git config says (an external tool or colour would hide every line,
  // other prefixes would misname files, textconv would rewrite the content).
  it("gives the same staged patch under hostile config", () => {
    dir = mkdtempSync(join(tmpdir(), "gw-patchargs-"));
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "é k.json"), "{}\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    writeFileSync(join(dir, "é k.json"), '{"a": 1}\n');
    git(dir, ["add", "-A"]);
    const run = () => spawnSync("git", patchDiffArgs("--cached"), { cwd: dir, env, encoding: "utf-8" }).stdout;
    const clean = run();
    expect(clean).toContain("diff --git a/é k.json b/é k.json");
    expect(clean).toContain('+{"a": 1}');
    for (const [k, v] of [
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.srcPrefix", "SRC/"],
      ["diff.dstPrefix", "DST/"],
      ["color.ui", "always"],
      ["core.quotePath", "true"],
      ["diff.external", "echo EXTERNAL"],
      ["diff.submodule", "log"],
    ]) {
      git(dir, ["config", k, v]);
    }
    writeFileSync(join(dir, ".gitattributes"), "*.json diff=upper\n");
    git(dir, ["config", "diff.upper.textconv", "tr a-z A-Z <"]);
    expect(run()).toBe(clean);
  });

  // The blame context sent to the AI: a root commit still shows its diff.
  it("patchShowArgs shows a root commit's diff whatever log.showRoot says", () => {
    dir = mkdtempSync(join(tmpdir(), "gw-patchargs-show-"));
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "f.txt"), "one\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "root"]);
    const run = () =>
      spawnSync("git", patchShowArgs("HEAD", "--", "f.txt"), { cwd: dir, env, encoding: "utf-8" }).stdout;
    const clean = run();
    expect(clean).toContain("+one");
    git(dir, ["config", "log.showRoot", "false"]);
    git(dir, ["config", "diff.noprefix", "true"]);
    git(dir, ["config", "color.ui", "always"]);
    expect(run()).toBe(clean);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitBlob } from "../repo-config.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("gitBlob", () => {
  it("returns a file at a revision byte for byte, or null when absent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gitwand-mcp-blob-"));
    dirs.push(cwd);
    const git = (...a: string[]) => execFileSync("git", a, { cwd });
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "a.txt"), "  indented\n\n");
    writeFileSync(join(cwd, "empty.txt"), "");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
    expect(gitBlob(cwd, "HEAD", "a.txt")).toBe("  indented\n\n");
    expect(gitBlob(cwd, "HEAD", "empty.txt")).toBe("");
    expect(gitBlob(cwd, "HEAD", "nope.txt")).toBeNull();
  });
});

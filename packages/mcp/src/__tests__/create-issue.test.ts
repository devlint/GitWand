/**
 * gitwand_create_issue (#301, part 6): helpers, then the tool through
 * handleToolCall on a real temp git repo with a fake `gh` on PATH.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRemoteUrl, targetsFrom, ghEnv } from "../tools/create_issue.js";
import { handleToolCall, registerTools } from "../tools/index.js";
import { FakeGh, repoJson, type FakeAnswer } from "./fake-gh.js";

describe("parseRemoteUrl", () => {
  const want = { host: "github.com", owner: "me", repo: "proj" };
  it.each([
    "https://github.com/me/proj.git",
    "https://github.com/me/proj",
    "https://github.com/me/proj/",
    "https://user@github.com/me/proj",
    "git@github.com:me/proj.git",
    "ssh://git@github.com:22/me/proj.git",
    "ssh://git@github.com/me/proj",
  ])("reads %s", (url) => {
    expect(parseRemoteUrl(url)).toEqual(want);
  });

  it("keeps an enterprise host", () => {
    expect(parseRemoteUrl("git@ghe.corp:team/app.git")).toEqual({ host: "ghe.corp", owner: "team", repo: "app" });
  });

  it.each(["/local/path", "../other", "file:///tmp/r.git", "https://github.com/onlyowner", "https://github.com/a/b/c", ""])(
    "refuses %s",
    (url) => {
      expect(parseRemoteUrl(url)).toBeNull();
    },
  );
});

describe("targetsFrom", () => {
  it("origin alone", () => {
    expect(targetsFrom(repoJson("me/proj"))).toEqual([{ repo: "me/proj", hasIssues: true, isOrigin: true }]);
  });

  it("a fork: origin, then its parent", () => {
    const j = repoJson("me/proj", { hasIssues: false, parent: repoJson("up/proj") });
    expect(targetsFrom(j)).toEqual([
      { repo: "me/proj", hasIssues: false, isOrigin: true },
      { repo: "up/proj", hasIssues: true, isOrigin: false },
    ]);
  });

  it("an archived repository takes no issue", () => {
    const j = repoJson("me/proj", { parent: repoJson("up/proj", { archived: true }) });
    expect(targetsFrom(j)[1].hasIssues).toBe(false);
  });

  it("parent without has_issues counts as without issues", () => {
    const j = repoJson("me/proj", { parent: { full_name: "up/proj" } });
    expect(targetsFrom(j)[1]).toEqual({ repo: "up/proj", hasIssues: false, isOrigin: false });
  });

  it("a parent is ignored when the repository is not a fork", () => {
    const j = { ...repoJson("me/proj"), fork: false, parent: repoJson("up/proj") };
    expect(targetsFrom(j)).toHaveLength(1);
  });

  it("nothing usable → no target", () => {
    expect(targetsFrom(null)).toEqual([]);
    expect(targetsFrom({ message: "Not Found" })).toEqual([]);
  });
});

describe("ghEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("passes gh what it needs and nothing else", () => {
    process.env.GH_TOKEN = "t1";
    process.env.GITHUB_TOKEN = "t2";
    process.env.AWS_SECRET_ACCESS_KEY = "nope";
    process.env.OPENAI_API_KEY = "nope";
    process.env.GH_REPO = "evil/repo";
    process.env.GH_HOST = "evil.host";
    const env = ghEnv();
    expect(env.GH_TOKEN).toBe("t1");
    expect(env.GITHUB_TOKEN).toBe("t2");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_REPO).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.GH_NO_UPDATE_NOTIFIER).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });
});

// ─── The tool ────────────────────────────────────────────────

const dirs: string[] = [];
let gh: FakeGh | null = null;
afterEach(() => {
  gh?.dispose();
  gh = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRepo(origin: string | null = "https://github.com/me/proj.git"): string {
  const cwd = mkdtempSync(join(tmpdir(), "gitwand-mcp-issue-"));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd });
  return cwd;
}

const ISSUE_URL = "https://github.com/me/proj/issues/12";

function fake(api: unknown = repoJson("me/proj"), create: FakeAnswer = { stdout: ISSUE_URL + "\n" }): FakeGh {
  gh = new FakeGh({ api: { stdout: JSON.stringify(api) }, "issue create": create });
  return gh;
}

async function call(cwd: string, args: Record<string, unknown>) {
  const res: any = await handleToolCall("gitwand_create_issue", args, cwd);
  return { isError: res.isError === true, out: JSON.parse(res.content[0].text) };
}

const creates = (g: FakeGh) => g.calls().filter((c) => c.argv[0] === "issue");
const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("gitwand_create_issue", () => {
  it("is registered, with dry_run documented as the default", () => {
    const tool = registerTools().find((t) => t.name === "gitwand_create_issue")!;
    expect(tool).toBeDefined();
    expect((tool.inputSchema as any).required).toEqual(["title"]);
    expect(tool.description).toMatch(/dry_run: false/);
  });

  it("previews by default and creates nothing", async () => {
    const g = fake();
    const { isError, out } = await call(makeRepo(), { title: "  Crash on save ", body: "Steps", labels: ["bug"] });
    expect(isError).toBe(false);
    expect(out).toMatchObject({
      dryRun: true,
      repo: "me/proj",
      isOrigin: true,
      title: "Crash on save",
      body: "Steps",
      labels: ["bug"],
      assignees: [],
      canCreate: true,
      secrets: { blocking: [], warnings: [] },
    });
    expect(out.next).toMatch(/dry_run: false/);
    expect(creates(g)).toHaveLength(0);
    expect(g.calls()[0].argv).toEqual(["api", "--hostname", "github.com", "repos/me/proj"]);
  });

  it("creates with dry_run: false, the body on stdin", async () => {
    const g = fake();
    const { isError, out } = await call(makeRepo(), {
      title: "T",
      body: "line 1\nline 2",
      labels: ["bug"],
      assignees: ["@me"],
      dry_run: false,
    });
    expect(isError).toBe(false);
    expect(out).toEqual({ created: true, repo: "me/proj", number: 12, url: ISSUE_URL });
    const [c] = creates(g);
    expect(c.argv).toEqual([
      "issue", "create", "--repo", "github.com/me/proj", "--title", "T", "--body-file", "-",
      "--label", "bug", "--assignee", "@me",
    ]);
    expect(c.stdin).toBe("line 1\nline 2");
  });

  it("files on the fork parent when the fork takes no issues", async () => {
    fake(repoJson("me/proj", { hasIssues: false, parent: repoJson("Up/Proj") }));
    const { out } = await call(makeRepo(), { title: "T" });
    expect(out).toMatchObject({ repo: "Up/Proj", isOrigin: false, canCreate: true });
  });

  it("an explicit repo, case-insensitive, must be one of the targets", async () => {
    fake(repoJson("me/proj", { parent: repoJson("up/proj") }));
    const cwd = makeRepo();
    expect((await call(cwd, { title: "T", repo: "UP/proj" })).out).toMatchObject({ repo: "up/proj" });
    const bad = await call(cwd, { title: "T", repo: "someone/else" });
    expect(bad.isError).toBe(true);
    expect(bad.out.error).toBe("repo_not_allowed");
  });

  it("a target without issues is refused", async () => {
    fake(repoJson("me/proj", { parent: repoJson("up/proj", { hasIssues: false }) }));
    const r = await call(makeRepo(), { title: "T", repo: "up/proj" });
    expect(r.out.error).toBe("issues_disabled");
  });

  it("no target with issues", async () => {
    fake(repoJson("me/proj", { archived: true }));
    expect((await call(makeRepo(), { title: "T" })).out.error).toBe("no_issue_target");
  });

  it("title secret blocks", async () => {
    const g = fake();
    const cwd = makeRepo();
    const preview = await call(cwd, { title: `leak ${token}`, body: "ok" });
    expect(preview.out.canCreate).toBe(false);
    expect(preview.out.secrets.blocking).toHaveLength(1);
    expect(preview.out.secrets.blocking[0].line).toBe(0);
    expect(JSON.stringify(preview.out.secrets)).not.toContain(token);
    const sent = await call(cwd, { title: `leak ${token}`, body: "ok", dry_run: false });
    expect(sent.isError).toBe(true);
    expect(sent.out.error).toBe("secrets_found");
    expect(creates(g)).toHaveLength(0);
  });

  it("a body secret keeps its line number", async () => {
    fake();
    const { out } = await call(makeRepo(), { title: "T", body: `a\nkey = "${token}"` });
    expect(out.secrets.blocking[0].line).toBe(2);
  });

  it("uses the repository's .gitwandrc patterns", async () => {
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "corp", regex: "CORP-[0-9]{6}", severity: "high", description: "corp id" }] } }),
    );
    const { out } = await call(cwd, { title: "T", body: "id CORP-123456" });
    expect(out.secrets.blocking.map((f: any) => f.patternId)).toEqual(["corp"]);
  });

  it.each([
    [{ title: "   " }, "invalid_title"],
    [{ title: "x".repeat(257) }, "invalid_title"],
    [{ title: "T", body: "x".repeat(65_537) }, "invalid_body"],
    [{ title: "T", labels: ["a,b"] }, "invalid_list"],
    [{ title: "T", labels: [""] }, "invalid_list"],
    [{ title: "T", assignees: "me" }, "invalid_list"],
    [{ title: "T", dry_run: "false" }, "invalid_dry_run"],
  ])("refuses %j", async (args, code) => {
    const g = fake();
    const r = await call(makeRepo(), args);
    expect(r.isError).toBe(true);
    expect(r.out.error).toBe(code);
    expect(g.calls()).toHaveLength(0);
  });

  it("a body of exactly 65,536 characters is fine", async () => {
    fake();
    expect((await call(makeRepo(), { title: "T", body: "x ".repeat(32_768) })).isError).toBe(false);
  });

  it("not a git repository", async () => {
    fake();
    const cwd = mkdtempSync(join(tmpdir(), "gitwand-mcp-norepo-"));
    dirs.push(cwd);
    expect((await call(cwd, { title: "T" })).out.error).toBe("not_a_repo");
  });

  it("no origin", async () => {
    fake();
    expect((await call(makeRepo(null), { title: "T" })).out.error).toBe("no_origin");
  });

  it("an origin that is not owner/repo", async () => {
    fake();
    expect((await call(makeRepo("/srv/git/proj.git"), { title: "T" })).out.error).toBe("unsupported_remote");
  });

  it("gh missing", async () => {
    const cwd = makeRepo();
    // git's exec dir holds `git` (and git-*), never `gh`.
    const gitDir = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
    const saved = process.env.PATH;
    process.env.PATH = gitDir;
    try {
      const r = await call(cwd, { title: "T" });
      expect(r.out.error).toBe("gh_missing");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("gh api failing → target_lookup_failed with gh's words", async () => {
    gh = new FakeGh({ api: { stderr: "HTTP 404: Not Found", code: 1 } });
    const r = await call(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("target_lookup_failed");
    expect(r.out.message).toContain("HTTP 404");
  });

  it("create failing → create_failed with gh's words", async () => {
    fake(repoJson("me/proj"), { stderr: "could not add label: 'nope' not found", code: 1 });
    const r = await call(makeRepo(), { title: "T", labels: ["nope"], dry_run: false });
    expect(r.isError).toBe(true);
    expect(r.out.error).toBe("create_failed");
    expect(r.out.message).toContain("could not add label");
  });

  it("an enterprise origin names its host", async () => {
    const g = fake(repoJson("me/proj"), { stdout: "https://ghe.corp/me/proj/issues/3\n" });
    const { out } = await call(makeRepo("git@ghe.corp:me/proj.git"), { title: "T", dry_run: false });
    expect(out).toMatchObject({ created: true, number: 3 });
    expect(g.calls()[0].argv).toEqual(["api", "--hostname", "ghe.corp", "repos/me/proj"]);
    expect(creates(g)[0].argv.slice(0, 4)).toEqual(["issue", "create", "--repo", "ghe.corp/me/proj"]);
  });
});

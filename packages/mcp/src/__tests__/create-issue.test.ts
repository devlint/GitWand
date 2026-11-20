/**
 * gitwand_create_issue (#301, part 6): helpers, then the tool through
 * handleToolCall on a real temp git repo with a fake `gh` on PATH.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRemoteUrl, targetsFrom, ghEnv, createIssueTimeouts, resetCreateIssueCaches, runGh } from "../tools/create_issue.js";
import { handleToolCall, registerTools } from "../tools/index.js";
import { FakeGh, repoJson, type FakeAnswer } from "./fake-gh.js";

describe("parseRemoteUrl", () => {
  const want = { host: "github.com", owner: "me", repo: "proj" };
  it.each([
    ["https://github.com/me/proj.git", false],
    ["https://github.com/me/proj", false],
    ["https://github.com/me/proj/", false],
    ["https://user@github.com/me/proj", false],
    ["git@github.com:me/proj.git", true],
    ["ssh://git@github.com:22/me/proj.git", true],
    ["ssh://git@github.com/me/proj", true],
  ])("reads %s", (url, ssh) => {
    expect(parseRemoteUrl(url)).toEqual({ ...want, ssh });
  });

  it("keeps an https port (the API is served there), not an ssh one", () => {
    expect(parseRemoteUrl("https://ghe.corp:8443/team/app.git")).toMatchObject({ host: "ghe.corp:8443" });
    expect(parseRemoteUrl("ssh://git@ghe.corp:2222/team/app.git")).toMatchObject({ host: "ghe.corp" });
  });

  it("keeps an enterprise host", () => {
    expect(parseRemoteUrl("git@ghe.corp:team/app.git")).toEqual({ host: "ghe.corp", owner: "team", repo: "app", ssh: true });
  });

  it.each([
    "/local/path",
    "../other",
    "file:///tmp/r.git",
    "https://github.com/onlyowner",
    "https://github.com/a/b/c",
    "https://github.com/o/r%E0.git",
    "https://github.com/me/proj?x=1#y/z",
    "",
  ])(
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
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const env = ghEnv();
    // gh's keyring (Secret Service on Linux) is reached over the session bus.
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
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
const timeouts = { ...createIssueTimeouts };
afterEach(() => {
  Object.assign(createIssueTimeouts, timeouts);
  resetCreateIssueCaches();
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

/** A preview, then the create it allows (its `previewId`). */
async function create(cwd: string, args: Record<string, unknown>) {
  const preview = await call(cwd, args);
  if (preview.isError) return preview;
  return call(cwd, { ...args, dry_run: false, preview_id: preview.out.previewId });
}

const creates = (g: FakeGh) => g.calls().filter((c) => c.tool === "gh" && c.argv[0] === "issue");
const apis = (g: FakeGh) => g.calls().filter((c) => c.tool === "gh" && c.argv[0] === "api");
const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("gitwand_create_issue", () => {
  it("is registered, with dry_run documented as the default", () => {
    const tool = registerTools().find((t) => t.name === "gitwand_create_issue")!;
    expect(tool).toBeDefined();
    expect((tool.inputSchema as any).required).toEqual(["title"]);
    expect((tool.inputSchema as any).properties.preview_id.type).toBe("string");
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
      bodyChars: 5,
      labels: ["bug"],
      assignees: [],
      canCreate: true,
      secrets: { blocking: [], warnings: [] },
    });
    expect(out.next).toMatch(/dry_run: false/);
    // The body is the agent's own text: not echoed back.
    expect(out.body).toBeUndefined();
    expect(out.previewId).toMatch(/^[0-9a-f]{64}$/);
    expect(creates(g)).toHaveLength(0);
    expect(g.calls().map((c) => c.argv)).toEqual([["api", "--hostname", "github.com", "repos/me/proj"]]);
  });

  it("creates with dry_run: false, the body on stdin", async () => {
    const g = fake();
    const { isError, out } = await create(makeRepo(), {
      title: "T",
      body: "line 1\nline 2",
      labels: ["bug"],
      assignees: ["@me"],
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
    expect(preview.out.secrets.blocking[0]).toMatchObject({ file: "title", line: 1 });
    expect(JSON.stringify(preview.out.secrets)).not.toContain(token);
    const sent = await call(cwd, { title: `leak ${token}`, body: "ok", dry_run: false });
    expect(sent.isError).toBe(true);
    expect(sent.out.error).toBe("secrets_found");
    expect(creates(g)).toHaveLength(0);
  });

  it("a body secret keeps its line number", async () => {
    fake();
    const { out } = await call(makeRepo(), { title: "T", body: `a\nkey = "${token}"` });
    expect(out.secrets.blocking[0]).toMatchObject({ file: "body", line: 2 });
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
    [{ title: "Crash\nmore" }, "invalid_title"],
    [{ title: "Bug\u0000x" }, "invalid_title"],
    [{ title: "T", labels: ["bu\u0000g"] }, "invalid_list"],
    [{ title: "T", assignees: ["me\tyou"] }, "invalid_list"],
    [{ title: "😀".repeat(257) }, "invalid_title"],
    [{ title: "Crash\r" + "more" }, "invalid_title"],
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
    const r = await create(makeRepo(), { title: "T", labels: ["nope"] });
    expect(r.isError).toBe(true);
    expect(r.out.error).toBe("create_failed");
    expect(r.out.message).toContain("could not add label");
  });

  it("an enterprise origin names its host", async () => {
    const g = fake(repoJson("me/proj"), { stdout: "https://ghe.corp/me/proj/issues/3\n" });
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj")) },
      "issue create": { stdout: "https://ghe.corp/me/proj/issues/3\n" },
      "auth status": { stdout: "" },
    });
    const { out } = await create(makeRepo("git@ghe.corp:me/proj.git"), { title: "T" });
    expect(out).toMatchObject({ created: true, number: 3 });
    expect(apis(g)[0].argv).toEqual(["api", "--hostname", "ghe.corp", "repos/me/proj"]);
    expect(creates(g)[0].argv.slice(0, 4)).toEqual(["issue", "create", "--repo", "ghe.corp/me/proj"]);
  });

  it("an SSH alias goes to the host ssh connects to", async () => {
    const g = fake();
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj")) },
      ssh: { stdout: "user git\nhostname github.com\nport 22\n" },
    });
    const { out } = await call(makeRepo("git@github-work:me/proj.git"), { title: "T" });
    expect(out.repo).toBe("me/proj");
    expect(g.calls().find((c) => c.tool === "ssh")!.argv).toEqual(["-G", "github-work"]);
    expect(apis(g)[0].argv).toEqual(["api", "--hostname", "github.com", "repos/me/proj"]);
  });

  it("ssh.github.com is github.com", async () => {
    const g = fake();
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj")) },
      ssh: { stdout: "hostname ssh.github.com\nport 443\n" },
    });
    await call(makeRepo("ssh://git@ssh.github.com:443/me/proj.git"), { title: "T" });
    expect(apis(g)[0].argv).toContain("github.com");
  });

  it("an https origin asks ssh nothing", async () => {
    const g = fake();
    await call(makeRepo(), { title: "T" });
    expect(g.calls().some((c) => c.tool === "ssh")).toBe(false);
  });

  it("a slow read is reported as such", async () => {
    createIssueTimeouts.readMs = 300;
    gh = new FakeGh({ api: { stdout: JSON.stringify(repoJson("me/proj")), sleepMs: 3000 } });
    const r = await call(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("target_lookup_failed");
    expect(r.out.message).toMatch(/did not answer/);
  });

  it("a create that times out may have created the issue", async () => {
    createIssueTimeouts.createMs = 300;
    fake(repoJson("me/proj"), { stdout: ISSUE_URL, sleepMs: 3000 });
    const r = await create(makeRepo(), { title: "T" });
    expect(r.isError).toBe(true);
    expect(r.out.error).toBe("create_uncertain");
    expect(r.out.message).toContain("https://github.com/me/proj/issues");
  });

  it("a create stopped by a signal may have created the issue too, and says why", async () => {
    fake(repoJson("me/proj"), { signal: "SIGTERM" });
    const r = await create(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("create_uncertain");
    expect(r.out.message).toMatch(/SIGTERM/);
    expect(r.out.message).not.toMatch(/did not answer/);
  });

  it("the default timeouts: 30 s to read, 60 s to create", () => {
    expect(timeouts).toEqual({ readMs: 30_000, createMs: 60_000, sshMs: 5_000 });
  });

  it("a title of 256 emoji is 256 characters", async () => {
    fake();
    expect((await call(makeRepo(), { title: "😀".repeat(256) })).isError).toBe(false);
  });

  it("a non-GitHub origin is refused before gh is asked about it", async () => {
    const g = new FakeGh({ "auth status": { stderr: "You are not logged into any accounts on gitlab.com", code: 1 } });
    gh = g;
    const r = await call(makeRepo("git@gitlab.com:team/app.git"), { title: "T" });
    expect(r.out.error).toBe("not_github");
    expect(g.calls().filter((c) => c.tool === "gh").map((c) => c.argv)).toEqual([["auth", "status", "--hostname", "gitlab.com"]]);
  });

  it("github.com needs no sign-in check", async () => {
    const g = fake();
    await call(makeRepo(), { title: "T" });
    expect(g.calls().some((c) => c.argv[0] === "auth")).toBe(false);
  });

  it.each([
    'Post "https://api.github.com/graphql": unexpected EOF',
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "read tcp 10.0.0.2:51000->140.82.112.6:443: read: connection reset by peer",
  ])("a create cut off by the network may have created the issue: %s", async (stderr) => {
    fake(repoJson("me/proj"), { stderr, code: 1 });
    const r = await create(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("create_uncertain");
    expect(r.out.message).toContain(stderr);
  });

  it("a slow gh does not block the server", async () => {
    fake(repoJson("me/proj"), { stdout: ISSUE_URL, sleepMs: 600 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      await create(makeRepo(), { title: "T" });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  it("a preview then a create read the target once, and ssh once", async () => {
    const g = fake();
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj")) },
      "issue create": { stdout: ISSUE_URL },
      ssh: { stdout: "hostname github.com\n" },
    });
    const cwd = makeRepo("git@github-work:me/proj.git");
    await call(cwd, { title: "T" });
    await create(cwd, { title: "T" });
    expect(g.calls().filter((c) => c.tool === "ssh")).toHaveLength(1);
    expect(apis(g)).toHaveLength(1);
  });

  it("a failed target read is not remembered", async () => {
    const g = new FakeGh({ api: { stderr: "HTTP 500", code: 1 } });
    gh = g;
    const cwd = makeRepo();
    await call(cwd, { title: "T" });
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) } });
    expect((await call(cwd, { title: "T" })).out.repo).toBe("me/proj");
  });

  it("a create needs the preview of the same issue", async () => {
    const g = fake();
    const cwd = makeRepo();
    const none = await call(cwd, { title: "T", dry_run: false });
    expect(none.isError).toBe(true);
    expect(none.out.error).toBe("preview_required");
    const preview = await call(cwd, { title: "T", body: "shown" });
    for (const changed of [{ body: "other" }, { labels: ["bug"] }, { title: "T2" }, { repo: "me/proj", body: "shown", assignees: ["x"] }]) {
      const r = await call(cwd, { title: "T", body: "shown", ...changed, dry_run: false, preview_id: preview.out.previewId });
      expect(r.out.error).toBe("preview_required");
    }
    expect((await call(cwd, { title: "T", body: "shown", dry_run: false, preview_id: "f".repeat(64) })).out.error).toBe("preview_required");
    expect(creates(g)).toHaveLength(0);
    const ok = await call(cwd, { title: "T", body: "shown", dry_run: false, preview_id: preview.out.previewId });
    expect(ok.out.created).toBe(true);
  });

  it("a blocked preview gives no previewId", async () => {
    fake();
    const { out } = await call(makeRepo(), { title: "T", body: token });
    expect(out.canCreate).toBe(false);
    expect(out.previewId).toBeUndefined();
  });

  it("the repository's .gitwandrc cannot allow-list a secret out of the blocking scan", async () => {
    fake();
    const cwd = makeRepo();
    writeFileSync(join(cwd, ".gitwandrc"), JSON.stringify({ secrets: { ignore: ["/ghp_[A-Za-z0-9]+/"] } }));
    const { out } = await call(cwd, { title: "T", body: token });
    expect(out.canCreate).toBe(false);
    expect(out.secrets.blocking.map((f: any) => f.patternId)).toEqual(["github_pat_classic"]);
  });

  it("an enterprise host gh cannot check is not called another forge", async () => {
    gh = new FakeGh({ "auth status": { stderr: "X Failed to log in to ghe.corp using token (GH_ENTERPRISE_TOKEN)\n  - The token in GH_ENTERPRISE_TOKEN is invalid.", code: 1 } });
    const r = await call(makeRepo("https://ghe.corp/me/proj.git"), { title: "T" });
    expect(r.out.error).toBe("gh_auth_failed");
    expect(r.out.message).toContain("token in GH_ENTERPRISE_TOKEN is invalid");
  });

  it("a failed ssh lookup is remembered too", async () => {
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "auth status": { stdout: "" }, ssh: { code: 255 } });
    const cwd = makeRepo("git@ghe.corp:me/proj.git");
    await call(cwd, { title: "T" });
    resetCreateIssueCaches({ keepHosts: true });
    await call(cwd, { title: "T" });
    expect(g.calls().filter((c) => c.tool === "ssh")).toHaveLength(1);
  });

  it("a slow git does not block the server either", async () => {
    fake();
    const cwd = makeRepo();
    // Two git calls (rev-parse, remote get-url) of 400 ms each.
    gh!.slowGit(400);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      await call(cwd, { title: "T" });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(25);
  });
});

describe("runGh", () => {
  it("a directory that is gone is not gh missing", async () => {
    gh = new FakeGh({});
    const r = await runGh(["--version"], join(tmpdir(), "gitwand-gone-" + Date.now()), undefined, 5_000);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ missing: false });
  });
});

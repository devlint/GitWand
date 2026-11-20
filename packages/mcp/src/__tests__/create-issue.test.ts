/**
 * gitwand_create_issue (#301, part 6): helpers, then the tool through
 * handleToolCall on a real temp git repo with a fake `gh` on PATH.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ghEnv, createIssueTimeouts, resetCreateIssueCaches, runGh, scanWorkerStarts, setScanCoreForTests } from "../tools/create_issue.js";
import { gitTryAsync, gitEnv } from "../repo-config.js";
import { handleToolCall, registerTools } from "../tools/index.js";
import { FakeGh, repoJson, type FakeAnswer } from "./fake-gh.js";

// Remote URLs (core's `parseRemoteUrl`) and the target rule (core's
// `issueTargetsFrom`) are tested in packages/core; their use is tested below.

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
    process.env.GH_ENTERPRISE_TOKEN = "ent";
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
    // An enterprise token only for the host GH_HOST names.
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(ghEnv("evil.host").GH_ENTERPRISE_TOKEN).toBe("ent");
    expect(ghEnv("other.host").GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.GH_NO_UPDATE_NOTIFIER).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });
});

// ─── The tool ────────────────────────────────────────────────

const dirs: string[] = [];
let gh: FakeGh | null = null;
const timeouts = { ...createIssueTimeouts };
const GH_VARS = ["GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const savedGh: Record<string, string | undefined> = {};
let ghConfig = "";

/** gh's hosts file: the hosts gh is signed in to (github.com and ghe.corp by default). */
function hostsYml(hosts: Record<string, { user: string; token: string }>) {
  writeFileSync(
    join(ghConfig, "hosts.yml"),
    Object.entries(hosts)
      .map(([h, a]) => `${h}:\n    user: ${a.user}\n    oauth_token: ${a.token}\n    git_protocol: https\n`)
      .join(""),
  );
}

beforeEach(() => {
  for (const k of GH_VARS) {
    savedGh[k] = process.env[k];
    delete process.env[k];
  }
  ghConfig = mkdtempSync(join(tmpdir(), "gitwand-gh-config-"));
  process.env.GH_CONFIG_DIR = ghConfig;
  hostsYml({ "github.com": { user: "octo", token: "t1" }, "ghe.corp": { user: "octo-corp", token: "t2" } });
});

afterEach(() => {
  for (const k of GH_VARS) {
    if (savedGh[k] === undefined) delete process.env[k];
    else process.env[k] = savedGh[k];
  }
  rmSync(ghConfig, { recursive: true, force: true });
  setScanCoreForTests(null);
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
/** GitHub's answer to a created issue (the fields the tool reads). */
const issueJson = (number = 12, url = ISSUE_URL) => JSON.stringify({ number, html_url: url, title: "x" });

function fake(api: unknown = repoJson("me/proj"), create: FakeAnswer = { stdout: issueJson() }): FakeGh {
  const answers: Record<string, FakeAnswer> = {
    api: { stdout: JSON.stringify(api) },
    "api POST": create,
    "api user": { stdout: JSON.stringify({ login: "octo" }) },
  };
  // A fork's parent, read on its own, answers as itself.
  const parent = (api as any)?.parent;
  if (parent?.full_name) answers[`api repos/${parent.full_name}`] = { stdout: JSON.stringify(parent) };
  gh = new FakeGh(answers);
  return gh;
}

async function call(
  cwd: string,
  args: Record<string, unknown>,
  confirm?: (message: string) => Promise<boolean | undefined>,
  signal?: AbortSignal,
) {
  const res: any = await handleToolCall("gitwand_create_issue", args, cwd, { confirm, signal });
  return { isError: res.isError === true, out: JSON.parse(res.content[0].text) };
}

/** A preview, then the create it allows (its `previewId`). */
async function create(cwd: string, args: Record<string, unknown>, confirm?: (message: string) => Promise<boolean | undefined>) {
  const preview = await call(cwd, args);
  if (preview.isError) return preview;
  return call(cwd, { ...args, dry_run: false, preview_id: preview.out.previewId }, confirm);
}

const creates = (g: FakeGh) => g.calls().filter((c) => c.tool === "gh" && c.argv.includes("POST"));
const apis = (g: FakeGh) => g.calls().filter((c) => c.tool === "gh" && c.argv[0] === "api" && !c.argv.includes("POST"));
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
    expect(out.previewId).toMatch(/^[0-9a-f]{76}$/);
    expect(creates(g)).toHaveLength(0);
    expect(g.calls().map((c) => c.argv)).toEqual([["api", "--hostname", "github.com", "repos/me/proj"]]);
  });

  it("creates with dry_run: false, the whole issue on stdin, nothing of it on the command line", async () => {
    const g = fake();
    const title = "Crash with KEY-zQ8vR2xL9pT4mN7bW1cY";
    const { isError, out } = await create(makeRepo(), {
      title,
      body: "line 1\nline 2",
      labels: ["bug", "a,b"],
      assignees: ["@me", "hubot"],
    });
    expect(isError).toBe(false);
    expect(out).toEqual({ created: true, confirmedBy: "agent", host: "github.com", repo: "me/proj", number: 12, url: ISSUE_URL });
    const [c] = creates(g);
    expect(c.argv).toEqual(["api", "--hostname", "github.com", "-X", "POST", "repos/me/proj/issues", "--input", "-"]);
    // `@me` is the signed-in login; a label may hold a comma.
    expect(JSON.parse(c.stdin!)).toEqual({ title, body: "line 1\nline 2", labels: ["bug", "a,b"], assignees: ["octo", "hubot"] });
  });

  it("the preview shows who @me is", async () => {
    fake();
    expect((await call(makeRepo(), { title: "T", assignees: ["@me"] })).out.assignees).toEqual(["octo"]);
  });

  it("@me that gh cannot name is refused", async () => {
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "api user": { stderr: "HTTP 401: Bad credentials", code: 1 } });
    const r = await call(makeRepo(), { title: "T", assignees: ["@me"] });
    expect(r.out.error).toBe("gh_auth_failed");
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
    // A blocked preview gives no id; whatever id is passed, the secret refuses it.
    const sent = await call(cwd, { title: `leak ${token}`, body: "ok", dry_run: false, preview_id: "0".repeat(76) });
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
    [{ title: "Bug\u2028x" }, "invalid_title"],
    [{ title: "Bug \u202eexe.txt" }, "invalid_title"],
    [{ title: "Bug\u0085x" }, "invalid_title"],
    [{ title: "T", labels: ["bug\u2066"] }, "invalid_list"],
    [{ title: "T", labels: ["bu\u0000g"] }, "invalid_list"],
    [{ title: "T", assignees: ["me\tyou"] }, "invalid_list"],
    [{ title: "😀".repeat(257) }, "invalid_title"],
    [{ title: "Crash\r" + "more" }, "invalid_title"],
    [{ title: "T", body: "x".repeat(65_537) }, "invalid_body"],
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
    fake(repoJson("me/proj"), { stderr: "gh: Validation Failed (HTTP 422)", code: 1 });
    const r = await create(makeRepo(), { title: "T", labels: ["nope"] });
    expect(r.isError).toBe(true);
    expect(r.out.error).toBe("create_failed");
    expect(r.out.message).toContain("Validation Failed (HTTP 422)");
  });

  it("an enterprise origin names its host", async () => {
    const g = fake();
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj")) },
      "api POST": { stdout: issueJson(3, "https://ghe.corp/me/proj/issues/3") },
      "auth status": { stdout: "" },
    });
    const { out } = await create(makeRepo("git@ghe.corp:me/proj.git"), { title: "T" });
    expect(out).toMatchObject({ created: true, number: 3 });
    expect(apis(g)[0].argv).toEqual(["api", "--hostname", "ghe.corp", "repos/me/proj"]);
    expect(creates(g)[0].argv.slice(0, 6)).toEqual(["api", "--hostname", "ghe.corp", "-X", "POST", "repos/me/proj/issues"]);
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
    fake(repoJson("me/proj"), { stdout: issueJson(), sleepMs: 3000 });
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
    expect(timeouts).toEqual({
      readMs: 30_000,
      createMs: 60_000,
      sshMs: 5_000,
      killGraceMs: 2_000,
      maxOutputBytes: 16 * 1024 * 1024,
      scanMs: 5_000,
      sshFailureTtlMs: 60_000,
      signedInTtlMs: 300_000,
      previewTtlMs: 3_600_000,
      sshOkTtlMs: 300_000,
    });
  });

  it("a title of 256 emoji is 256 characters", async () => {
    fake();
    expect((await call(makeRepo(), { title: "😀".repeat(256) })).isError).toBe(false);
  });

  it("a non-GitHub origin is refused before gh is asked about it", async () => {
    const g = new FakeGh({ "auth status": { stdout: "" } });
    gh = g;
    const r = await call(makeRepo("git@gitlab.com:team/app.git"), { title: "T" });
    expect(r.out.error).toBe("not_github");
    // gh is never pointed at a host it has no sign-in for.
    expect(g.calls().filter((c) => c.tool === "gh")).toHaveLength(0);
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
    fake(repoJson("me/proj"), { stdout: issueJson(), sleepMs: 600 });
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
      "api POST": { stdout: issueJson() },
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
    expect((await call(cwd, { title: "T", body: "shown", dry_run: false, preview_id: "f".repeat(76) })).out.error).toBe("preview_required");
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

  it("labels and assignees need triage rights on the target", async () => {
    const g = fake(repoJson("me/proj", { hasIssues: false, parent: repoJson("up/proj", { triage: null }) }));
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj", { hasIssues: false, parent: repoJson("up/proj", { triage: null }) })) },
      "api repos/up/proj": { stdout: JSON.stringify(repoJson("up/proj", { triage: false })) },
    });
    const cwd = makeRepo();
    const r = await call(cwd, { title: "T", labels: ["bug"] });
    expect(r.out.error).toBe("cannot_triage");
    expect(r.out.message).toContain("up/proj");
    expect((await call(cwd, { title: "T" })).out).toMatchObject({ repo: "up/proj", canCreate: true });
  });

  it("the parent's rights come from reading it on its own", async () => {
    const g = fake();
    g.answer({
      api: { stdout: JSON.stringify(repoJson("me/proj", { hasIssues: false, parent: repoJson("up/proj", { triage: null }) })) },
      "api repos/up/proj": { stdout: JSON.stringify(repoJson("up/proj", { triage: true })) },
    });
    expect((await call(makeRepo(), { title: "T", labels: ["bug"] })).out).toMatchObject({ repo: "up/proj", labels: ["bug"] });
  });

  it("a preview allows one create", async () => {
    const g = fake();
    const cwd = makeRepo();
    const preview = await call(cwd, { title: "T" });
    const args = { title: "T", dry_run: false, preview_id: preview.out.previewId };
    expect((await call(cwd, args)).out.created).toBe(true);
    const again = await call(cwd, args);
    expect(again.out.error).toBe("preview_used");
    expect(creates(g)).toHaveLength(1);
  });

  it("an uncertain create uses up its preview too; a refused one does not", async () => {
    const g = fake(repoJson("me/proj"), { stderr: "HTTP 502: Bad Gateway", code: 1 });
    const cwd = makeRepo();
    const p1 = await call(cwd, { title: "T" });
    const a1 = { title: "T", dry_run: false, preview_id: p1.out.previewId };
    expect((await call(cwd, a1)).out.error).toBe("create_uncertain");
    expect((await call(cwd, a1)).out.error).toBe("preview_used");
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "api POST": { stderr: "gh: Validation Failed (HTTP 422)", code: 1 } });
    const p2 = await call(cwd, { title: "U" });
    const a2 = { title: "U", dry_run: false, preview_id: p2.out.previewId };
    expect((await call(cwd, a2)).out.error).toBe("create_failed");
    expect((await call(cwd, a2)).out.error).toBe("create_failed");
  });

  it("a child that ignores SIGTERM is killed, and the call returns", async () => {
    createIssueTimeouts.readMs = 300;
    createIssueTimeouts.killGraceMs = 200;
    gh = new FakeGh({ api: { stdout: "{}", sleepMs: 20_000, ignoreTerm: true } });
    const t = Date.now();
    const r = await call(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("target_lookup_failed");
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  it("a failed ssh lookup is asked again once its time is up", async () => {
    createIssueTimeouts.sshFailureTtlMs = 0;
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "auth status": { stdout: "" }, ssh: { code: 255 } });
    const cwd = makeRepo("git@ghe.corp:me/proj.git");
    await call(cwd, { title: "T" });
    await call(cwd, { title: "T" });
    expect(g.calls().filter((c) => c.tool === "ssh")).toHaveLength(2);
  });

  it("a repository pattern that backtracks forever fails closed without blocking the server", async () => {
    createIssueTimeouts.scanMs = 500;
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "bad", regex: "(a+)+$", severity: "high", description: "x" }] } }),
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call(cwd, { title: "T", body: "a".repeat(40) + "!" });
    } finally {
      clearInterval(timer);
    }
    expect(r!.out.error).toBe("scan_failed");
    expect(ticks).toBeGreaterThan(10);
  });

  it("a repository's own patterns still apply through the worker", async () => {
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "corp", regex: "CORP-[0-9]{6}", severity: "high", description: "x" }] } }),
    );
    const { out } = await call(cwd, { title: "id CORP-123456" });
    expect(out.secrets.blocking).toMatchObject([{ patternId: "corp", file: "title", line: 1 }]);
  });

  it("an output flood is named as such", async () => {
    createIssueTimeouts.maxOutputBytes = 1_000;
    fake(repoJson("me/proj"), { floodBytes: 5_000, sleepMs: 2_000 });
    const r = await create(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("create_uncertain");
    expect(r.out.message).toMatch(/more than 1000 bytes/);
  });

  it("an enterprise sign-in is checked again after a while", async () => {
    createIssueTimeouts.signedInTtlMs = 0;
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "auth status": { stdout: "" } });
    const cwd = makeRepo("https://ghe.corp/me/proj.git");
    expect((await call(cwd, { title: "T" })).isError).toBe(false);
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "auth status": { stderr: "You are not logged into any accounts on ghe.corp", code: 1 } });
    expect((await call(cwd, { title: "T" })).out.error).toBe("not_github");
  });

  it.each(["HTTP 401: Bad credentials (https://api.github.com/repos/me/proj)", "To get started with GitHub CLI, please run:  gh auth login"])(
    "a sign-in problem on github.com is named: %s",
    async (stderr) => {
      gh = new FakeGh({ api: { stderr, code: 1 } });
      const r = await call(makeRepo(), { title: "T" });
      expect(r.out.error).toBe("gh_auth_failed");
      expect(r.out.message).toContain(stderr);
    },
  );

  it("the user is asked when the client can ask, and a no files nothing", async () => {
    const g = fake();
    const cwd = makeRepo();
    const asked: string[] = [];
    const no = await create(cwd, { title: "Crash", body: "steps", labels: ["bug"] }, async (m) => (asked.push(m), false));
    expect(no.out.error).toBe("declined");
    expect(creates(g)).toHaveLength(0);
    expect(asked[0]).toContain("me/proj");
    expect(asked[0]).toContain("Crash");
    expect(asked[0]).toContain("steps");
    expect(asked[0]).toContain("bug");
    const yes = await create(cwd, { title: "Crash", body: "steps", labels: ["bug"] }, async () => true);
    expect(yes.out.created).toBe(true);
  });

  it("a client that cannot ask relies on the preview", async () => {
    fake();
    expect((await create(makeRepo(), { title: "T" }, async () => undefined)).out.created).toBe(true);
  });

  it("two creates of one preview at once file it once", async () => {
    const g = fake(repoJson("me/proj"), { stdout: issueJson(), sleepMs: 300 });
    const cwd = makeRepo();
    const p = await call(cwd, { title: "T" });
    const args = { title: "T", dry_run: false, preview_id: p.out.previewId };
    const [a, b] = await Promise.all([call(cwd, args), call(cwd, args)]);
    const outs = [a.out, b.out];
    expect(outs.filter((o) => o.created === true)).toHaveLength(1);
    expect(outs.filter((o) => o.error === "preview_used")).toHaveLength(1);
    expect(creates(g)).toHaveLength(1);
  });

  it("a declined or failed confirmation leaves the preview usable", async () => {
    const g = fake();
    const cwd = makeRepo();
    const p = await call(cwd, { title: "T" });
    const args = { title: "T", dry_run: false, preview_id: p.out.previewId };
    expect((await call(cwd, args, async () => false)).out.error).toBe("declined");
    const failed = await call(cwd, args, async () => {
      throw new Error("Request timed out");
    });
    expect(failed.out.error).toBe("confirm_failed");
    expect(failed.out.message).toContain("Request timed out");
    expect(creates(g)).toHaveLength(0);
    expect((await call(cwd, args, async () => true)).out.created).toBe(true);
  });

  it("an underscore SSH alias is resolved too", async () => {
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, ssh: { stdout: "hostname github.com\n" } });
    await call(makeRepo("git@github_work:me/proj.git"), { title: "T" });
    expect(g.calls().find((c) => c.tool === "ssh")!.argv).toEqual(["-G", "github_work"]);
    expect(apis(g)[0].argv).toContain("github.com");
  });

  it("a connection that never opened is a plain failure: nothing was sent", async () => {
    fake(repoJson("me/proj"), { stderr: 'Post "https://api.github.com/repos/me/proj/issues": net/http: TLS handshake timeout', code: 1 });
    const cwd = makeRepo();
    const p = await call(cwd, { title: "T" });
    const args = { title: "T", dry_run: false, preview_id: p.out.previewId };
    expect((await call(cwd, args)).out.error).toBe("create_failed");
    expect((await call(cwd, args)).out.error).toBe("create_failed");
  });

  it("another gh account reads the targets again", async () => {
    const g = fake();
    const cwd = makeRepo();
    const saved = process.env.GH_TOKEN;
    try {
      process.env.GH_TOKEN = "account-a";
      expect((await call(cwd, { title: "T", labels: ["bug"] })).isError).toBe(false);
      process.env.GH_TOKEN = "account-b";
      g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj", { triage: false })) } });
      expect((await call(cwd, { title: "T", labels: ["bug"] })).out.error).toBe("cannot_triage");
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });

  it("one scan worker serves every call, and a stuck one is replaced", async () => {
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "corp", regex: "CORP-[0-9]{6}", severity: "high", description: "x" }] } }),
    );
    const before = scanWorkerStarts();
    await call(cwd, { title: "a" });
    await call(cwd, { title: "b" });
    await call(cwd, { title: "c" });
    expect(scanWorkerStarts() - before).toBe(1);

    // A pattern that never ends: that worker is dropped, the next scan gets a new one.
    createIssueTimeouts.scanMs = 500;
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "bad", regex: "(a+)+$", severity: "high", description: "x" }] } }),
    );
    expect((await call(cwd, { title: "T", body: "a".repeat(40) + "!" })).out.error).toBe("scan_failed");
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "corp", regex: "CORP-[0-9]{6}", severity: "high", description: "x" }] } }),
    );
    expect((await call(cwd, { title: "id CORP-123456" })).out.secrets.blocking[0].patternId).toBe("corp");
    expect(scanWorkerStarts() - before).toBe(2);
  });

  it.each([
    ["read tcp 10.0.0.2:51000->140.82.112.6:443: i/o timeout", "create_uncertain"],
    ["net/http: request canceled (Client.Timeout exceeded while awaiting headers)", "create_uncertain"],
    ["context deadline exceeded", "create_uncertain"],
    ["gh: Request Timeout (HTTP 408)", "create_uncertain"],
    ["something gh never said before", "create_uncertain"],
    ["gh: Validation Failed (HTTP 422)", "create_failed"],
    ["gh: Not Found (HTTP 404)", "create_failed"],
    ['Post "https://api.github.com/repos/me/proj/issues": dial tcp: lookup api.github.com: no such host', "create_failed"],
    ['Post "https://api.github.com/repos/me/proj/issues": dial tcp 140.82.112.6:443: connect: connection refused', "create_failed"],
  ])("only a failure that sent nothing is safe to retry: %s", async (stderr, code) => {
    fake(repoJson("me/proj"), { stderr, code: 1 });
    expect((await create(makeRepo(), { title: "T" })).out.error).toBe(code);
  });

  it("a malformed or missing preview_id is refused before anything runs", async () => {
    const g = fake();
    const cwd = makeRepo();
    for (const preview_id of [undefined, "x", "f".repeat(64)]) {
      expect((await call(cwd, { title: "T", dry_run: false, preview_id })).out.error).toBe("preview_required");
    }
    expect(g.calls()).toHaveLength(0);
  });

  it("a preview expires", async () => {
    createIssueTimeouts.previewTtlMs = 0;
    fake();
    const r = await create(makeRepo(), { title: "T" });
    expect(r.out.error).toBe("preview_expired");
  });

  it("a cancelled call creates nothing and frees its preview", async () => {
    const g = fake();
    const cwd = makeRepo();
    const p = await call(cwd, { title: "T" });
    const args = { title: "T", dry_run: false, preview_id: p.out.previewId };
    const ac = new AbortController();
    const r = await call(cwd, args, async () => (ac.abort(), true), ac.signal);
    expect(r.out.error).toBe("cancelled");
    expect(creates(g)).toHaveLength(0);
    expect((await call(cwd, args)).out.created).toBe(true);
  });

  it("a parent that could not be read is not taken as one without rights, nor remembered", async () => {
    const g = fake();
    const fork = repoJson("me/proj", { hasIssues: false, parent: repoJson("up/proj", { triage: null }) });
    g.answer({ api: { stdout: JSON.stringify(fork) }, "api repos/up/proj": { stderr: "HTTP 502: Bad Gateway", code: 1 } });
    const cwd = makeRepo();
    const r = await call(cwd, { title: "T", labels: ["bug"] });
    expect(r.out.error).toBe("target_lookup_failed");
    expect(r.out.message).toContain("up/proj");
    // Without labels the target itself is known well enough.
    expect((await call(cwd, { title: "T" })).out.repo).toBe("up/proj");
    g.answer({ api: { stdout: JSON.stringify(fork) }, "api repos/up/proj": { stdout: JSON.stringify(repoJson("up/proj")) } });
    expect((await call(cwd, { title: "T", labels: ["bug"] })).out).toMatchObject({ repo: "up/proj", labels: ["bug"] });
  });

  it("queued scans keep to their time limit", async () => {
    createIssueTimeouts.scanMs = 400;
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "bad", regex: "(a+)+$", severity: "high", description: "x" }] } }),
    );
    // Warm the worker so its start-up is not in the measure.
    await call(cwd, { title: "warm" });
    const t = Date.now();
    const rs = await Promise.all([1, 2, 3].map(() => call(cwd, { title: "T", body: "a".repeat(40) + "!" })));
    expect(rs.map((r) => r.out.error)).toEqual(["scan_failed", "scan_failed", "scan_failed"]);
    // Each asked at once: none waits for the others' overruns.
    expect(Date.now() - t).toBeLessThan(400 * 2 + 300);
  });

  it("cancelling during the POST stops gh, and the issue may exist", async () => {
    const g = fake(repoJson("me/proj"), { stdout: issueJson(), sleepMs: 5_000 });
    const cwd = makeRepo();
    const p = await call(cwd, { title: "T" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t = Date.now();
    const r = await call(cwd, { title: "T", dry_run: false, preview_id: p.out.previewId }, undefined, ac.signal);
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(r.out.error).toBe("create_uncertain");
    expect(creates(g)).toHaveLength(1);
    expect((await call(cwd, { title: "T", dry_run: false, preview_id: p.out.previewId })).out.error).toBe("preview_used");
  });

  it("a preview made under one gh account does not create under another", async () => {
    fake();
    const cwd = makeRepo();
    const saved = process.env.GH_TOKEN;
    try {
      process.env.GH_TOKEN = "account-a";
      const p = await call(cwd, { title: "T" });
      process.env.GH_TOKEN = "account-b";
      expect((await call(cwd, { title: "T", dry_run: false, preview_id: p.out.previewId })).out.error).toBe("preview_required");
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });

  it("a parent read that answers nothing usable is an unread parent", async () => {
    const g = fake();
    const fork = repoJson("me/proj", { hasIssues: false, parent: repoJson("up/proj", { triage: null }) });
    g.answer({ api: { stdout: JSON.stringify(fork) }, "api repos/up/proj": { stdout: JSON.stringify({ message: "odd" }) } });
    expect((await call(makeRepo(), { title: "T", labels: ["bug"] })).out.error).toBe("target_lookup_failed");
  });

  it("labels and assignees are scanned too", async () => {
    fake();
    const { out } = await call(makeRepo(), { title: "T", labels: ["ok", token] });
    expect(out.canCreate).toBe(false);
    expect(out.secrets.blocking).toMatchObject([{ file: "labels", line: 2, patternId: "github_pat_classic" }]);
  });

  it("a cancelled call stops at whatever gh is doing", async () => {
    gh = new FakeGh({ api: { stdout: JSON.stringify(repoJson("me/proj")), sleepMs: 10_000 } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t = Date.now();
    const r = await call(makeRepo(), { title: "T" }, undefined, ac.signal);
    expect(r.out.error).toBe("cancelled");
    expect(Date.now() - t).toBeLessThan(3_000);
  });

  it("assignees are deduplicated, whatever their case, @me or not", async () => {
    fake();
    expect((await call(makeRepo(), { title: "T", assignees: ["alice", "Alice", "bob"] })).out.assignees).toEqual(["alice", "bob"]);
    expect((await call(makeRepo(), { title: "T", assignees: ["@me", "octo", "OCTO"] })).out.assignees).toEqual(["octo"]);
  });

  it("says who confirmed the create", async () => {
    fake();
    expect((await create(makeRepo(), { title: "T" }, async () => true)).out.confirmedBy).toBe("user");
    expect((await create(makeRepo(), { title: "T" }, async () => undefined)).out.confirmedBy).toBe("agent");
  });

  it("an enterprise token never goes to a host gh is not signed in to", async () => {
    process.env.GH_ENTERPRISE_TOKEN = "ghe-secret";
    const g = fake();
    const r = await call(makeRepo("https://attacker.example/o/r.git"), { title: "T" });
    expect(r.out.error).toBe("not_github");
    expect(g.calls()).toHaveLength(0);
  });

  it("GH_HOST names an enterprise host gh may use its token for", async () => {
    process.env.GH_HOST = "ghe.env";
    process.env.GH_ENTERPRISE_TOKEN = "ghe-secret";
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, "auth status": { stdout: "" } });
    expect((await call(makeRepo("https://ghe.env/me/proj.git"), { title: "T" })).isError).toBe(false);
    expect(apis(g)[0].argv).toContain("ghe.env");
  });

  it("a token refresh keeps the preview; another user does not", async () => {
    fake();
    const cwd = makeRepo();
    const p1 = await call(cwd, { title: "T" });
    hostsYml({ "github.com": { user: "octo", token: "refreshed" }, "ghe.corp": { user: "octo-corp", token: "t2" } });
    expect((await call(cwd, { title: "T", dry_run: false, preview_id: p1.out.previewId })).out.created).toBe(true);
    const p2 = await call(cwd, { title: "U" });
    hostsYml({ "github.com": { user: "someone-else", token: "t9" }, "ghe.corp": { user: "octo-corp", token: "t2" } });
    expect((await call(cwd, { title: "U", dry_run: false, preview_id: p2.out.previewId })).out.error).toBe("preview_required");
  });

  it("a cancelled call does not wait for the secrets scan", async () => {
    createIssueTimeouts.scanMs = 20_000;
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "bad", regex: "(a+)+$", severity: "high", description: "x" }] } }),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const t = Date.now();
    const r = await call(cwd, { title: "T", body: "a".repeat(40) + "!" }, undefined, ac.signal);
    expect(r.out.error).toBe("cancelled");
    expect(Date.now() - t).toBeLessThan(3_000);
  });

  it("@me in any case is the signed-in login", async () => {
    fake();
    expect((await call(makeRepo(), { title: "T", assignees: ["@Me"] })).out.assignees).toEqual(["octo"]);
  });

  it.each([["Ap\u200bproved"], ["x\u2060y"], ["B\ufeffOM"]])("refuses an invisible character: %j", async (title) => {
    fake();
    expect((await call(makeRepo(), { title })).out.error).toBe("invalid_title");
    expect((await call(makeRepo(), { title: "T", labels: [title] })).out.error).toBe("invalid_list");
  });

  it("a scanner that cannot start says so, not that a pattern hangs", async () => {
    setScanCoreForTests("file:///nonexistent/gitwand-core.js");
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "corp", regex: "CORP-[0-9]{6}", severity: "high", description: "x" }] } }),
    );
    expect((await call(cwd, { title: "T" })).out.error).toBe("scan_unavailable");
  });

  it("the preview and the question name the host too", async () => {
    const g = fake();
    g.answer({
      api: { stdout: JSON.stringify(repoJson("acme/app")) },
      "api POST": { stdout: issueJson(3, "https://ghe.corp/acme/app/issues/3") },
      "auth status": { stdout: "" },
      ssh: { stdout: "hostname ghe.corp\n" },
    });
    const cwd = makeRepo("git@work:acme/app.git");
    expect((await call(cwd, { title: "T" })).out).toMatchObject({ host: "ghe.corp", repo: "acme/app" });
    const asked: string[] = [];
    await create(cwd, { title: "T" }, async (m) => (asked.push(m), true));
    expect(asked[0]).toContain("ghe.corp/acme/app");
  });

  it("a resolved ssh alias is asked again after a while", async () => {
    createIssueTimeouts.sshOkTtlMs = 0;
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("me/proj")) }, ssh: { stdout: "hostname github.com\n" } });
    const cwd = makeRepo("git@github-work:me/proj.git");
    await call(cwd, { title: "T" });
    await call(cwd, { title: "T" });
    expect(g.calls().filter((c) => c.tool === "ssh")).toHaveLength(2);
  });

  it("a host signed in with its port is known", async () => {
    hostsYml({ "github.com": { user: "octo", token: "t1" }, "ghe.example.com:8443": { user: "o", token: "t" } });
    const g = fake();
    g.answer({ api: { stdout: JSON.stringify(repoJson("o/r")) }, "auth status": { stdout: "" } });
    const r = await call(makeRepo("https://ghe.example.com:8443/o/r.git"), { title: "T" });
    expect(r.out).toMatchObject({ host: "ghe.example.com:8443", repo: "o/r" });
  });

  it("a scan worker that dies is unavailable, not a slow pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gitwand-crash-core-"));
    dirs.push(dir);
    writeFileSync(join(dir, "core.mjs"), "export function scanReportBody() { process.exit(3); }\n");
    setScanCoreForTests(new URL(`file://${join(dir, "core.mjs")}`).href);
    fake();
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, ".gitwandrc"),
      JSON.stringify({ secrets: { patterns: [{ id: "corp", regex: "CORP-[0-9]{6}", severity: "high", description: "x" }] } }),
    );
    expect((await call(cwd, { title: "T" })).out.error).toBe("scan_unavailable");
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

describe("gitTryAsync", () => {
  it("gives up on a git that does not answer", async () => {
    gh = new FakeGh({});
    gh.slowGit(3_000);
    const cwd = mkdtempSync(join(tmpdir(), "gitwand-mcp-slowgit-"));
    dirs.push(cwd);
    const t = Date.now();
    expect(await gitTryAsync(cwd, ["--version"], 300)).toBeNull();
    expect(Date.now() - t).toBeLessThan(2_500);
  });
});

describe("gitEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("gives git what it needs, no token", () => {
    process.env.GH_TOKEN = "t";
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.GIT_DIR = "/x/.git";
    process.env.GIT_CONFIG_GLOBAL = "/x/gitconfig";
    process.env.GIT_HTTP_PASSWORD = "p";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = "cat";
    const env = gitEnv();
    expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(["1", "core.pager", "cat"]);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.GIT_DIR).toBe("/x/.git");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/x/gitconfig");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GIT_HTTP_PASSWORD).toBeUndefined();
  });
});
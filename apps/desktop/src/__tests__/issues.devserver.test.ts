/**
 * dev-server issue creation helpers (#301) — the rules the Rust commands
 * apply in `commands/gh_issues.rs` (`targets_from`, `check_target`,
 * `issue_payload`), so `pnpm dev:web` exercises the same behaviour.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no type declarations
import { devIssueTargetsFrom, devResolveIssueTarget, devIssuePayload, devAssigneesFrom, devGithubError, devLabelsFrom, devMilestonesFrom, devCreateFailure, devGitwandReport, devTemplateFiles } from "../../dev-issues.mjs";

const origin = (hasIssues: boolean, fork: boolean, parent?: object) => ({
  full_name: "me/app", html_url: "https://github.com/me/app", has_issues: hasIssues, fork, parent,
});
const parent = (hasIssues: boolean) => ({ full_name: "org/app", html_url: "https://github.com/org/app", has_issues: hasIssues });

describe("devIssueTargetsFrom", () => {
  it("lists origin alone when it is not a fork", () => {
    const t = devIssueTargetsFrom(origin(true, false, parent(true)));
    expect(t.targets.map((x: { repo: string }) => x.repo)).toEqual(["me/app"]);
    expect(t.defaultRepo).toBe("me/app");
  });

  it("adds the parent of a fork and defaults to it when origin has issues off", () => {
    const t = devIssueTargetsFrom(origin(false, true, parent(true)));
    expect(t.targets.map((x: { repo: string }) => x.repo)).toEqual(["me/app", "org/app"]);
    expect(t.defaultRepo).toBe("org/app");
  });

  it("has no default when no target has issues", () => {
    expect(devIssueTargetsFrom(origin(false, true, parent(false))).defaultRepo).toBeNull();
  });
});

describe("devResolveIssueTarget", () => {
  const t = devIssueTargetsFrom(origin(true, true, parent(false)));
  it("refuses a repository that is not a target", () => {
    expect(devResolveIssueTarget(t, "evil/repo")).toEqual({ error: "Not an issue target for this repository: evil/repo" });
  });
  it("refuses a target with issues off", () => {
    expect(devResolveIssueTarget(t, "org/app")).toEqual({ error: "Issues are disabled on org/app" });
  });
  it("gives GitHub's spelling of a target with issues, whatever the case asked", () => {
    expect(devResolveIssueTarget(t, "ME/App")).toEqual({ repo: "me/app" });
  });
});

describe("devIssuePayload", () => {
  it("refuses a whitespace-only title", () => {
    expect(devIssuePayload({ title: " \n ", body: "" })).toEqual({ error: "Title is required" });
  });

  it("trims the title, keeps the body verbatim and leaves out empty optionals", () => {
    const body = 'a "q" \\ $HOME\n--flag\r\n\té — 日本\n'.repeat(2000);
    expect(devIssuePayload({ title: "  Bug  ", body, labels: [], assignees: [], milestone: null })).toEqual({
      payload: { title: "Bug", body },
    });
  });

  it("carries labels, assignees and milestone", () => {
    expect(devIssuePayload({ title: "t", body: "b", labels: ["bug"], assignees: ["me"], milestone: 3 }).payload).toEqual({
      title: "t", body: "b", labels: ["bug"], assignees: ["me"], milestone: 3,
    });
  });
});

describe("devIssueTargetsFrom — triage rights", () => {
  it("reads triage or push rights from permissions", () => {
    const t = devIssueTargetsFrom({ ...origin(true, true, { ...parent(true), permissions: { triage: false, pull: true } }), permissions: { push: true } });
    expect(t.targets.map((x: { canTriage: boolean }) => x.canTriage)).toEqual([true, false]);
  });
});

describe("devAssigneesFrom", () => {
  it("deduplicates, sorts by login and keeps the Rust shape", () => {
    expect(devAssigneesFrom([{ login: "zed" }, { login: "Amy", avatar_url: "a" }, { login: "zed" }, {}])).toEqual([
      { login: "Amy", name: null, avatar_url: "a" },
      { login: "zed", name: null, avatar_url: null },
    ]);
  });
});

describe("devGithubError", () => {
  it("keeps the 422 field details, as the Rust map_api_error does", () => {
    const body = { message: "Validation Failed", errors: [{ resource: "Issue", field: "assignees", code: "invalid" }, { message: "milestone not found" }] };
    expect(devGithubError(422, body)).toBe("GitHub API error (422): Validation Failed (assignees: invalid; milestone not found)");
  });
  it("falls back to the status", () => {
    expect(devGithubError(500, {})).toBe("GitHub API error (500): HTTP 500");
  });
});

describe("devLabelsFrom / devMilestonesFrom", () => {
  it("map labels like labels_from (empty description → null, nameless dropped)", () => {
    expect(devLabelsFrom([{ name: "bug", color: "d73a4a", description: "" }, { color: "x" }])).toEqual([
      { name: "bug", color: "d73a4a", description: null },
    ]);
  });
  it("map milestones like milestones_from (dueOn, untitled dropped)", () => {
    expect(devMilestonesFrom([{ number: 3, title: "v4", due_on: "2026-12-01T00:00:00Z" }, { number: 4 }])).toEqual([
      { number: 3, title: "v4", dueOn: "2026-12-01T00:00:00Z" },
    ]);
  });
});


describe("devIssueTargetsFrom — archived", () => {
  it("offers an archived repository as taking no issue, like targets_from", () => {
    const t = devIssueTargetsFrom({ ...origin(true, false), archived: true });
    expect(t.targets[0].hasIssues).toBe(false);
    expect(t.defaultRepo).toBeNull();
  });
});

describe("devCreateFailure", () => {
  it("marks a 5xx after the POST as 'may have been created', like the Rust create", () => {
    expect(devCreateFailure(502, { message: "Server Error" })).toBe("[may-have-been-created] GitHub API error (502): Server Error");
  });
  it("keeps a refusal a plain error", () => {
    expect(devCreateFailure(422, { message: "Validation Failed" })).toBe("GitHub API error (422): Validation Failed");
  });
});

describe("devGitwandReport", () => {
  it("targets devlint/GitWand with a title and body only", () => {
    expect(devGitwandReport({ title: " t ", body: "b", labels: ["x"], milestone: 1 }, {})).toEqual({
      repo: "devlint/GitWand",
      payload: { title: "t", body: "b" },
    });
  });
  it("goes to GITWAND_DEV_REPORT_REPO when set (QA on a test fork)", () => {
    expect(devGitwandReport({ title: "t", body: "" }, { GITWAND_DEV_REPORT_REPO: "me/fork" }).repo).toBe("me/fork");
  });
  it("refuses a blank title", () => {
    expect(devGitwandReport({ title: " ", body: "b" }, {})).toEqual({ error: "Title is required" });
  });
});

describe("devTemplateFiles (#301): the same rules as gh_issue_templates", () => {
  const b64 = (t: string) => Buffer.from(t).toString("base64").replace(/(.{60})/g, "$1\n");
  const file = (t: string) => ({ encoding: "base64", content: b64(t), size: t.length });
  const entry = (name: string, size = 10) => ({ name, path: `.github/ISSUE_TEMPLATE/${name}`, type: "file", size });
  const PUBLIC = async () => true;
  const fake = (m: Record<string, unknown>) => async (nwo: string, path: string) => (m[`${nwo}:${path}`] ?? null);

  it("reads the directory, sorted and capped, skipping other files", async () => {
    const dir = [...Array.from({ length: 22 }, (_, i) => entry(`t${String(21 - i).padStart(2, "0")}.md`)), entry("config.yml"), entry("notes.txt")];
    const m: Record<string, unknown> = { "me/app:.github/ISSUE_TEMPLATE": dir, "me/app:.github/ISSUE_TEMPLATE/config.yml": file("blank_issues_enabled: false") };
    for (let i = 0; i < 22; i++) m[`me/app:.github/ISSUE_TEMPLATE/t${String(i).padStart(2, "0")}.md`] = file("body");
    const got = await devTemplateFiles("me/app", PUBLIC, fake(m));
    expect(got.source).toBe("me/app");
    expect(got.files).toHaveLength(21);
    expect(got.files[0].path).toBe(".github/ISSUE_TEMPLATE/config.yml");
    expect(got.files[20].path).toBe(".github/ISSUE_TEMPLATE/t19.md");
    expect(got.files[1].content).toBe("body");
  });

  it("skips a file over 64 KiB", async () => {
    const got = await devTemplateFiles("me/app", PUBLIC, fake({
      "me/app:.github/ISSUE_TEMPLATE": [entry("big.md", 65_537), entry("ok.yml")],
      "me/app:.github/ISSUE_TEMPLATE/ok.yml": file("name: ok"),
    }));
    expect(got.files.map((f: { path: string }) => f.path)).toEqual([".github/ISSUE_TEMPLATE/ok.yml"]);
  });

  it("falls back to a single-template file, then the owner's .github repository", async () => {
    const single = await devTemplateFiles("me/app", PUBLIC, fake({ "me/app:docs/ISSUE_TEMPLATE.md": file("legacy") }));
    expect(single.files[0].path).toBe("docs/ISSUE_TEMPLATE.md");
    const org = await devTemplateFiles("me/app", PUBLIC, fake({
      "me/.github:.github/ISSUE_TEMPLATE": [entry("bug.yml")],
      "me/.github:.github/ISSUE_TEMPLATE/bug.yml": file("name: Bug"),
    }));
    expect(org.source).toBe("me/.github");
    expect(org.files[0].content).toBe("name: Bug");
  });

  it("a template folder with only config.yml still tries the single-template file", async () => {
    const got = await devTemplateFiles("me/app", PUBLIC, fake({
      "me/app:.github/ISSUE_TEMPLATE": [entry("config.yml")],
      "me/app:.github/ISSUE_TEMPLATE/config.yml": file("blank_issues_enabled: false"),
      "me/app:.github/ISSUE_TEMPLATE.md": file("legacy"),
    }));
    expect(got.files.map((f: { path: string }) => f.path)).toEqual([".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE.md"]);
  });

  it("nothing anywhere is an empty list", async () => {
    expect((await devTemplateFiles("me/app", PUBLIC, fake({}))).files).toEqual([]);
  });

  it("percent-encodes a file name with a space or brackets", async () => {
    const got = await devTemplateFiles("me/app", PUBLIC, fake({
      "me/app:.github/ISSUE_TEMPLATE": [entry("bug report.md"), entry("a[b].yml")],
      "me/app:.github/ISSUE_TEMPLATE/bug%20report.md": file("a"),
      "me/app:.github/ISSUE_TEMPLATE/a%5Bb%5D.yml": file("b"),
    }));
    expect(got.files.map((f: { path: string }) => f.path)).toEqual([".github/ISSUE_TEMPLATE/a[b].yml", ".github/ISSUE_TEMPLATE/bug report.md"]);
  });

  it("one file that fails is skipped, the others kept", async () => {
    const got = await devTemplateFiles("me/app", PUBLIC, async (nwo: string, path: string) => {
      if (path === ".github/ISSUE_TEMPLATE") return [entry("a.md"), entry("b.md")];
      if (path === ".github/ISSUE_TEMPLATE/a.md") throw new Error("timeout");
      return nwo === "me/app" ? file("b") : null;
    });
    expect(got.files.map((f: { path: string }) => f.path)).toEqual([".github/ISSUE_TEMPLATE/b.md"]);
  });

  it("a private owner .github repository is not used", async () => {
    const got = await devTemplateFiles("me/app", async () => false, fake({
      "me/.github:.github/ISSUE_TEMPLATE": [entry("bug.yml")],
      "me/.github:.github/ISSUE_TEMPLATE/bug.yml": file("name: Bug"),
    }));
    expect(got.files).toEqual([]);
  });

  it("a file that is not UTF-8 is skipped, as in Rust", async () => {
    const bad = { encoding: "base64", content: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"), size: 3 };
    const got = await devTemplateFiles("me/app", PUBLIC, fake({ "me/app:.github/ISSUE_TEMPLATE": [entry("x.md")], "me/app:.github/ISSUE_TEMPLATE/x.md": bad }));
    expect(got.files).toEqual([]);
  });

  it("a non-404 error fails the read", async () => {
    await expect(devTemplateFiles("me/app", PUBLIC, async () => { throw new Error("502"); })).rejects.toThrow("502");
  });
});

/**
 * dev-server issue creation helpers (#301) — the rules the Rust commands
 * apply in `commands/gh_issues.rs` (`targets_from`, `check_target`,
 * `issue_payload`), so `pnpm dev:web` exercises the same behaviour.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no type declarations
import { devIssueTargetsFrom, devResolveIssueTarget, devIssuePayload, devAssigneesFrom, devGithubError, devLabelsFrom, devMilestonesFrom, devCreateFailure, devGitwandReport } from "../../dev-issues.mjs";

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

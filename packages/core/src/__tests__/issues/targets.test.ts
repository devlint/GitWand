import { describe, it, expect } from "vitest";
import { issueTargetsFrom } from "../../issues/targets.js";
import * as core from "../../index.js";

const repo = (fullName: string, o: { hasIssues?: boolean; archived?: boolean; perms?: Record<string, boolean> | null; parent?: object } = {}) => ({
  full_name: fullName,
  html_url: `https://github.com/${fullName}`,
  has_issues: o.hasIssues ?? true,
  archived: o.archived ?? false,
  fork: o.parent !== undefined,
  ...(o.parent ? { parent: o.parent } : {}),
  ...(o.perms === null ? {} : { permissions: o.perms ?? { triage: true } }),
});

describe("issueTargetsFrom", () => {
  it("is exported by core", () => {
    expect(core.issueTargetsFrom).toBe(issueTargetsFrom);
  });

  it("origin alone", () => {
    expect(issueTargetsFrom(repo("me/proj"))).toEqual({
      targets: [{ repo: "me/proj", htmlUrl: "https://github.com/me/proj", hasIssues: true, isOrigin: true, canTriage: true }],
      defaultRepo: "me/proj",
    });
  });

  it("a fork: origin, then its parent, the default the first with issues", () => {
    const t = issueTargetsFrom(repo("me/proj", { hasIssues: false, parent: repo("up/proj") }));
    expect(t.targets.map((x) => [x.repo, x.isOrigin, x.hasIssues])).toEqual([
      ["me/proj", true, false],
      ["up/proj", false, true],
    ]);
    expect(t.defaultRepo).toBe("up/proj");
  });

  it("an archived repository takes no issue; no default then", () => {
    const t = issueTargetsFrom(repo("me/proj", { archived: true }));
    expect(t.targets[0].hasIssues).toBe(false);
    expect(t.defaultRepo).toBeNull();
  });

  it("a parent without has_issues takes none", () => {
    expect(issueTargetsFrom(repo("me/proj", { parent: { full_name: "up/proj" } })).targets[1]).toMatchObject({ hasIssues: false, canTriage: false, htmlUrl: "" });
  });

  it("a parent is ignored when the repository is not a fork", () => {
    expect(issueTargetsFrom({ ...repo("me/proj"), fork: false, parent: repo("up/proj") }).targets).toHaveLength(1);
  });

  it("triage rights: triage, push, maintain or admin; none given is none", () => {
    expect(issueTargetsFrom(repo("a/b", { perms: { triage: false, pull: true } })).targets[0].canTriage).toBe(false);
    expect(issueTargetsFrom(repo("a/b", { perms: null })).targets[0].canTriage).toBe(false);
    expect(issueTargetsFrom(repo("a/b", { perms: { push: true } })).targets[0].canTriage).toBe(true);
  });

  it("a parent read on its own replaces the embedded copy; an unusable one does not", () => {
    const o = repo("me/proj", { parent: repo("up/proj", { perms: null }) });
    expect(issueTargetsFrom(o).targets[1].canTriage).toBe(false);
    expect(issueTargetsFrom(o, repo("up/proj")).targets[1].canTriage).toBe(true);
    expect(issueTargetsFrom(o, { message: "Not Found" }).targets[1].repo).toBe("up/proj");
  });

  it("nothing usable → no target", () => {
    expect(issueTargetsFrom(null)).toEqual({ targets: [], defaultRepo: null });
    expect(issueTargetsFrom({ message: "Not Found" })).toEqual({ targets: [], defaultRepo: null });
  });
});

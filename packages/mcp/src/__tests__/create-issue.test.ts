/**
 * gitwand_create_issue (#301, part 6): helpers, then the tool through
 * handleToolCall on a real temp git repo with a fake `gh` on PATH.
 */
import { describe, it, expect, afterEach } from "vitest";
import { parseRemoteUrl, targetsFrom, ghEnv } from "../tools/create_issue.js";
import { repoJson } from "./fake-gh.js";

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

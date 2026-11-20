import { describe, it, expect } from "vitest";
import { parseRemoteUrl } from "../../issues/remote.js";
import * as core from "../../index.js";

describe("parseRemoteUrl", () => {
  it("is exported by core", () => {
    expect(core.parseRemoteUrl).toBe(parseRemoteUrl);
  });

  it("a git:// port is the git daemon's, not the host's", () => {
    expect(parseRemoteUrl("git://ghe.corp:9418/team/app.git")).toMatchObject({ host: "ghe.corp" });
  });

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


import { describe, it, expect } from "vitest";
import { mapCICheck } from "../backend-pr";

describe("mapCICheck", () => {
  it("maps the backends' snake_case fields, link and commit included", () => {
    expect(
      mapCICheck({ name: "b", state: "completed", conclusion: "success", details_url: "https://ci/1", commit_sha: "abc" }),
    ).toEqual({ name: "b", state: "completed", conclusion: "success", detailsUrl: "https://ci/1", commitSha: "abc" });
  });

  it("reads a check with no commit (an older backend) as one that does not say", () => {
    expect(mapCICheck({ name: "b", state: "", conclusion: "", details_url: "" }).commitSha).toBe("");
  });
});

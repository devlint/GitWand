/**
 * dagLayout.ts — parseRefs() ref-classification tests.
 *
 * Regression coverage for #137: `git branch test/some_experiment` then
 * switching away leaves the branch decorated as the bare name
 * `test/some_experiment` (no `HEAD -> ` prefix, since it isn't checked out).
 * parseRefs() used to classify ANY ref containing `/` as `type: "remote"`
 * on the assumption it must have shape `<remote>/<branch>` — which silently
 * mis-tags a slash-named local branch too. Consumers (CommitGraph.vue) then
 * stripped everything up to the first `/`, truncating `test/some_experiment`
 * down to `some_experiment` for checkout and delete actions.
 *
 * parseRefs() no longer guesses "remote" from the presence of `/` alone —
 * genuine remote refs are only resolved downstream against the real branch
 * list (see CommitGraph.vue's commitRefs()). This file only pins the
 * behavior parseRefs() itself is responsible for: it must not eagerly
 * label a slash-containing name "remote".
 */

import { describe, it, expect } from "vitest";
import { parseRefs } from "../dagLayout";

describe("parseRefs", () => {
  it("does not classify a slash-containing name as remote by default", () => {
    const parsed = parseRefs("test/some_experiment");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("test/some_experiment");
    expect(parsed[0].type).not.toBe("remote");
  });

  it("keeps the full name intact for a slash-named ref (no truncation)", () => {
    const parsed = parseRefs("test/some_experiment");
    expect(parsed[0].name).toBe("test/some_experiment");
  });

  it("still classifies a checked-out slash-named branch as branch (HEAD -> prefix)", () => {
    const parsed = parseRefs("HEAD -> test/some_experiment");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "branch", name: "test/some_experiment" });
  });

  it("classifies a plain (no-slash) name as branch", () => {
    const parsed = parseRefs("main");
    expect(parsed[0]).toEqual({ type: "branch", name: "main" });
  });

  it("still classifies HEAD, tag: and stash markers correctly", () => {
    expect(parseRefs("HEAD")[0]).toEqual({ type: "head", name: "HEAD" });
    expect(parseRefs("tag: v1.0.0")[0]).toEqual({ type: "tag", name: "v1.0.0" });
    expect(parseRefs("refs/stash")[0]).toEqual({ type: "stash", name: "stash" });
  });

  it("parses multiple comma-separated decorations, including a slash-named one", () => {
    const parsed = parseRefs("HEAD -> main, test/some_experiment, tag: v2.0.0");
    const names = parsed.map((r) => r.name);
    expect(names).toContain("main");
    expect(names).toContain("test/some_experiment");
    expect(names).toContain("v2.0.0");
    const experiment = parsed.find((r) => r.name === "test/some_experiment");
    expect(experiment?.type).not.toBe("remote");
  });
});

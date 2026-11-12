import { describe, expect, it } from "vitest";

import { parseInline } from "../advent/inline.js";

describe("parseInline", () => {
  it("splits code and strong segments", () => {
    expect(parseInline("Run `git add -p` then **Stage hunk**.")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "git add -p" },
      { kind: "text", text: " then " },
      { kind: "strong", text: "Stage hunk" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps an unmatched marker as literal text", () => {
    expect(parseInline("a ` b")).toEqual([{ kind: "text", text: "a ` b" }]);
    expect(parseInline("a ** b")).toEqual([{ kind: "text", text: "a ** b" }]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseInline("")).toEqual([]);
  });
});

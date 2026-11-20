import { describe, expect, it } from "vitest";

import { parseInline, plainText } from "../advent/inline.js";

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

  it("keeps an empty code span literal", () => {
    expect(parseInline("a `` b")).toEqual([{ kind: "text", text: "a `` b" }]);
  });

  it("does not nest markers: the outer one wins, inner backticks stay literal", () => {
    expect(parseInline("**a `b` c**")).toEqual([{ kind: "strong", text: "a `b` c" }]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseInline("")).toEqual([]);
  });
});

describe("plainText", () => {
  it("drops code and strong markers", () => {
    expect(plainText("Run `git add -p` then **Stage hunk**.")).toBe("Run git add -p then Stage hunk.");
  });

  it("keeps an unmatched marker literal", () => {
    expect(plainText("a ` b")).toBe("a ` b");
  });
});

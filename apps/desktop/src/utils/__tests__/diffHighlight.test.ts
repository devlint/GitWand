import { describe, it, expect } from "vitest";
import { highlightConflict } from "../diffHighlight";

describe("highlightConflict", () => {
  it("wraps only the changed token when one word differs", () => {
    const { ours } = highlightConflict(["hello brave world"], ["hello cruel world"], []);
    expect(ours.lines[0]).toBe('hello <span class="diff-add">brave</span> world');
  });

  it("returns escaped plain text for identical lines", () => {
    const { ours } = highlightConflict(["same line"], ["same line"], []);
    expect(ours.lines[0]).toBe("same line");
  });

  it("escapes &, <, > in output", () => {
    const { ours } = highlightConflict(["a<b> && c"], ["a<b> && d"], []);
    expect(ours.lines[0]).toContain("&lt;b&gt;");
    expect(ours.lines[0]).toContain("&amp;&amp;");
  });

  it("falls back to whole-line highlight for pathological line lengths without freezing", () => {
    const words = Array.from({ length: 5000 }, (_, i) => `token${i}`);
    const sideA = words.join(" ");
    const sideB = words.slice().reverse().join(" ");

    const { ours } = highlightConflict([sideA], [sideB], []);

    expect(ours.lines[0]).toBe(`<span class="diff-add">${sideA}</span>`);
  });
});

import { describe, it, expect } from "vitest";
import { locateBlock } from "../../history/locate.js";

describe("locateBlock", () => {
  const file = ["a", "x", "y", "b", "x", "y", "c"];

  it("returns the 1-based inclusive range of a unique block", () => {
    expect(locateBlock(["a", "b", "c", "d"], ["b", "c"], 1)).toEqual({ start: 2, end: 3 });
  });

  it("picks the occurrence nearest to nearLine when duplicated", () => {
    expect(locateBlock(file, ["x", "y"], 1)).toEqual({ start: 2, end: 3 });
    expect(locateBlock(file, ["x", "y"], 6)).toEqual({ start: 5, end: 6 });
  });

  it("returns null when the block is absent, empty, or longer than the file", () => {
    expect(locateBlock(file, ["nope"], 1)).toBeNull();
    expect(locateBlock(file, [], 1)).toBeNull();
    expect(locateBlock(["a"], ["a", "b"], 1)).toBeNull();
  });

  it("matches across CRLF and LF line endings", () => {
    expect(locateBlock(["a", "b", "c"], ["b\r", "c\r"], 1)).toEqual({ start: 2, end: 3 });
    expect(locateBlock(["a\r", "b\r", "c\r"], ["b", "c"], 1)).toEqual({ start: 2, end: 3 });
  });
});

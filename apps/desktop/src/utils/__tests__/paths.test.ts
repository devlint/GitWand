import { describe, it, expect } from "vitest";
import { isUnderPath } from "../paths";

describe("isUnderPath", () => {
  it("matches the root itself and what is inside it, by component", () => {
    expect(isUnderPath("/a/wt/sub", "/a/wt")).toBe(true);
    expect(isUnderPath("/a/wt", "/a/wt")).toBe(true);
    expect(isUnderPath("/a/wt/", "/a/wt")).toBe(true);
    expect(isUnderPath("/a/wt/sub", "/a/wt/")).toBe(true);
    expect(isUnderPath("/a/wt2", "/a/wt")).toBe(false);
    expect(isUnderPath("/a", "/a/wt")).toBe(false);
  });

  it("handles Windows separators", () => {
    expect(isUnderPath("C:\\r\\wt\\sub", "C:\\r\\wt")).toBe(true);
    expect(isUnderPath("C:\\r\\wt2", "C:\\r\\wt")).toBe(false);
  });
});

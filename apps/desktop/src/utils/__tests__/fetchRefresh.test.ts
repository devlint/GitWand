import { describe, expect, it } from "vitest";
import { shouldForceLogAfterFetch } from "../fetchRefresh";

// #287 follow-up: forcing the log after every background fetch cut the Git
// Tree back to the viewed depth and refilled it every 30 s, even when the
// fetch brought nothing.
describe("shouldForceLogAfterFetch", () => {
  it("does not force when the fetch moved no ref", () => {
    expect(shouldForceLogAfterFetch({ success: true, message: "", refsChanged: false }, false)).toBe(false);
  });

  it("forces when a ref moved", () => {
    expect(shouldForceLogAfterFetch({ success: true, message: "", refsChanged: true }, false)).toBe(true);
  });

  it("forces when the backend could not tell", () => {
    expect(shouldForceLogAfterFetch({ success: true, message: "" }, false)).toBe(true);
  });

  it("always forces on a manual sync", () => {
    expect(shouldForceLogAfterFetch({ success: true, message: "", refsChanged: false }, true)).toBe(true);
  });
});

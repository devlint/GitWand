// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isToggleModifier, IS_MAC } from "../platform";

describe("isToggleModifier", () => {
  it("is Cmd on mac and Ctrl elsewhere", () => {
    expect(isToggleModifier({ metaKey: true, ctrlKey: false })).toBe(IS_MAC);
    expect(isToggleModifier({ metaKey: false, ctrlKey: true })).toBe(!IS_MAC);
  });
});

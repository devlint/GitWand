import { describe, it, expect } from "vitest";
import { resolveDirtyPullAction } from "../pullDirtyDecision";

describe("resolveDirtyPullAction", () => {
  it("clean tree always pulls directly", () => {
    expect(resolveDirtyPullAction(false, "ask")).toBe("direct");
    expect(resolveDirtyPullAction(false, "refuse")).toBe("direct");
    expect(resolveDirtyPullAction(false, "autostash")).toBe("direct");
  });

  it("dirty + ask opens the modal", () => {
    expect(resolveDirtyPullAction(true, "ask")).toBe("modal");
  });

  it("dirty + refuse refuses", () => {
    expect(resolveDirtyPullAction(true, "refuse")).toBe("refuse");
  });

  it("dirty + autostash pulls with --autostash, no prompt", () => {
    expect(resolveDirtyPullAction(true, "autostash")).toBe("autostash");
  });
});

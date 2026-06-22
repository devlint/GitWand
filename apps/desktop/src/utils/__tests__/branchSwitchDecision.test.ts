import { describe, it, expect } from "vitest";
import { resolveDirtySwitchAction } from "../branchSwitchDecision";

describe("resolveDirtySwitchAction", () => {
  it("clean tree always switches directly", () => {
    expect(resolveDirtySwitchAction(false, "ask")).toBe("direct");
    expect(resolveDirtySwitchAction(false, "refuse")).toBe("direct");
    expect(resolveDirtySwitchAction(false, "stash")).toBe("direct");
  });

  it("dirty + ask opens the modal", () => {
    expect(resolveDirtySwitchAction(true, "ask")).toBe("modal");
  });

  it("dirty + refuse refuses", () => {
    expect(resolveDirtySwitchAction(true, "refuse")).toBe("refuse");
  });

  it("dirty + stash does not open the new modal (caller keeps stash flow)", () => {
    expect(resolveDirtySwitchAction(true, "stash")).toBe("direct");
  });
});

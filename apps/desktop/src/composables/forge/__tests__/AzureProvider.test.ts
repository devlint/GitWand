/**
 * AzureProvider — F2 (v3.6.0): `updateComment`/`deleteComment` are honest
 * unsupported errors (typed `ForgeNotImplementedError`), never a bare
 * runtime throw, so the UI can hide the affordance instead of crashing.
 */
import { describe, it, expect } from "vitest";
import { AzureProvider } from "../AzureProvider";
import { ForgeNotImplementedError } from "../types";

describe("AzureProvider — comment edit/delete capability (F2)", () => {
  it("updateComment throws a typed ForgeNotImplementedError", () => {
    const provider = new AzureProvider();
    expect(() => provider.updateComment("/repo", 1, "new body")).toThrow(ForgeNotImplementedError);
    try {
      provider.updateComment("/repo", 1, "new body");
    } catch (err: any) {
      expect(err.name).toBe("ForgeNotImplementedError");
    }
  });

  it("deleteComment throws a typed ForgeNotImplementedError", () => {
    const provider = new AzureProvider();
    expect(() => provider.deleteComment("/repo", 1)).toThrow(ForgeNotImplementedError);
    try {
      provider.deleteComment("/repo", 1);
    } catch (err: any) {
      expect(err.name).toBe("ForgeNotImplementedError");
    }
  });
});

import { describe, it, expect } from "vitest";
import { describeResetError } from "../useCommitActions";

const t = (key: string, ...args: any[]) => `${key}|${args.join(",")}`;

describe("describeResetError", () => {
  it("names the blocking files for a --keep refusal", () => {
    const msg = describeResetError(new Error("reset-keep-blocked:a.txt\nsrc/b.ts"), t);
    expect(msg).toBe("commitCtx.resetKeepBlocked|a.txt, src/b.ts");
  });

  it("falls back to the generic sentence when git named no file", () => {
    expect(describeResetError("reset-keep-blocked:", t)).toBe("commitCtx.resetKeepBlockedGeneric|");
  });

  it("copes with a wrapper around the marker", () => {
    expect(describeResetError(new Error("Error: reset-keep-blocked:a.txt"), t)).toContain("a.txt");
  });

  it("leaves other failures untouched", () => {
    expect(describeResetError(new Error("git reset --hard failed: bad revision"), t)).toBe(
      "git reset --hard failed: bad revision",
    );
  });
});

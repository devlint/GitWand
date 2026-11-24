import { describe, it, expect } from "vitest";
import { combinedErrorMessage, rawErrorText } from "../combinedError";

const t = (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key);

describe("combinedErrorMessage", () => {
  it("maps each known backend error to its key with its argument", () => {
    expect(combinedErrorMessage("Combined diffs need git 2.38 or later (found 2.37).", t)).toBe("combined.errGit:2.37");
    expect(combinedErrorMessage("Combined diffs need git 2.38 or later (found unknown).", t)).toBe("combined.errGit:unknown");
    expect(combinedErrorMessage("Select at least 2 commits.", t)).toBe("combined.errMin");
    expect(combinedErrorMessage("Select at most 50 commits.", t)).toBe("combined.tooMany:50");
    expect(combinedErrorMessage("Invalid commit hash: --output=x", t)).toBe("combined.errHash:--output=x");
    expect(combinedErrorMessage("Unknown commit: deadbeef", t)).toBe("combined.errUnknown:deadbeef");
    expect(combinedErrorMessage("Combined diffs do not support the file name: plan b/f.txt", t))
      .toBe("combined.errName:plan b/f.txt");
  });

  it("keeps a name with a newline whole", () => {
    expect(combinedErrorMessage("Combined diffs do not support the file name: a\nb", t)).toBe("combined.errName:a\nb");
  });

  it("shows an unknown error as is, and only exact matches are mapped", () => {
    expect(combinedErrorMessage("git merge-tree failed: boom", t)).toBe("git merge-tree failed: boom");
    expect(combinedErrorMessage("Error: Unknown commit: x", t)).toBe("Error: Unknown commit: x");
    expect(combinedErrorMessage("Select at least 2 commits. Really", t)).toBe("Select at least 2 commits. Really");
  });
});

describe("rawErrorText", () => {
  it("takes an Error's message verbatim", () => {
    expect(rawErrorText(new Error("Unknown commit: abc1234"))).toBe("Unknown commit: abc1234");
  });
  it("keeps a string rejection (Tauri invoke rejects with one) verbatim", () => {
    expect(rawErrorText("Unknown commit: abc1234")).toBe("Unknown commit: abc1234");
  });
});

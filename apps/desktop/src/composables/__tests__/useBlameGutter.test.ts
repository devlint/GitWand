import { describe, it, expect } from "vitest";
import { formatBlameDate, buildBlameModel } from "../useBlameGutter";
import type { BlameLine } from "../../utils/backend";

function line(partial: Partial<BlameLine> & { finalLine: number; hashFull: string }): BlameLine {
  return {
    hash: partial.hashFull.slice(0, 8),
    hashFull: partial.hashFull,
    finalLine: partial.finalLine,
    origLine: partial.origLine ?? partial.finalLine,
    author: partial.author ?? "Ada Lovelace",
    authorDate: partial.authorDate ?? "1751500800", // 2025-07-03 UTC-ish
    summary: partial.summary ?? "Initial commit",
    content: partial.content ?? "code",
  };
}

describe("formatBlameDate", () => {
  it("formats epoch seconds to YYYY-MM-DD", () => {
    // 1_700_000_000 = 2023-11-14
    expect(formatBlameDate("1700000000")).toBe("2023-11-14");
  });

  it("returns empty string for missing or unparseable input", () => {
    expect(formatBlameDate("")).toBe("");
    expect(formatBlameDate("not-a-number")).toBe("");
    expect(formatBlameDate("0")).toBe("");
    expect(formatBlameDate("-5")).toBe("");
  });
});

describe("buildBlameModel", () => {
  it("keys entries by 1-based final line number", () => {
    const model = buildBlameModel([
      line({ finalLine: 1, hashFull: "a".repeat(40) }),
      line({ finalLine: 2, hashFull: "a".repeat(40) }),
    ]);
    expect(model.has(1)).toBe(true);
    expect(model.has(2)).toBe(true);
    expect(model.get(1)!.hashFull).toBe("a".repeat(40));
  });

  it("shows the label only on the first line of a same-commit run", () => {
    const model = buildBlameModel([
      line({ finalLine: 1, hashFull: "a".repeat(40) }),
      line({ finalLine: 2, hashFull: "a".repeat(40) }),
      line({ finalLine: 3, hashFull: "b".repeat(40) }),
      line({ finalLine: 4, hashFull: "a".repeat(40) }), // same commit as 1/2 but not consecutive → shows again
    ]);
    expect(model.get(1)!.showLabel).toBe(true);
    expect(model.get(2)!.showLabel).toBe(false);
    expect(model.get(3)!.showLabel).toBe(true);
    expect(model.get(4)!.showLabel).toBe(true);
  });

  it("builds a compact `author · date` label and a rich tooltip", () => {
    const model = buildBlameModel([
      line({ finalLine: 1, hashFull: "c".repeat(40), author: "Grace Hopper", authorDate: "1700000000", summary: "Fix parser" }),
    ]);
    const entry = model.get(1)!;
    expect(entry.label).toBe("Grace Hopper · 2023-11-14");
    expect(entry.title).toContain("Grace Hopper");
    expect(entry.title).toContain("Fix parser");
    expect(entry.hashShort).toBe("cccccccc");
  });

  it("falls back gracefully when author/date are missing", () => {
    const model = buildBlameModel([
      line({ finalLine: 1, hashFull: "d".repeat(40), author: "", authorDate: "", summary: "" }),
    ]);
    const entry = model.get(1)!;
    expect(entry.label).toBe("Unknown");
    expect(entry.title).toContain("Unknown");
  });
});

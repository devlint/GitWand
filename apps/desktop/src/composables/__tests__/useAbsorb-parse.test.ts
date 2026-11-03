/**
 * `useAbsorb`'s diff parser: a removed line whose content is `-- a/x` is the
 * diff line `--- a/x`. It used to be read as a file header, so every later
 * hunk of that file was blamed against a file named `x`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/backend", () => ({ gitExec: vi.fn() }));
vi.mock("../useAIProvider", () => ({ useAIProvider: () => ({}) }));

import { parseDiffHunks } from "../useAbsorb";

describe("useAbsorb parseDiffHunks", () => {
  it("keeps each hunk on its own file when a hunk line looks like a header", () => {
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "index 111..222 100644",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,3 +1,2 @@",
      " SELECT 1;",
      "--- a/other.sql",
      "-++ b/other.sql",
      "+++ b/also-not-a-header",
      "@@ -10,2 +9,2 @@",
      "-x",
      "+y",
      " z",
      "diff --git a/b.ts b/b.ts",
      "index 333..444 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -4 +4 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    expect(parseDiffHunks(diff)).toEqual([
      { filePath: "q.sql", origStart: 1, origCount: 3 },
      { filePath: "q.sql", origStart: 10, origCount: 2 },
      { filePath: "b.ts", origStart: 4, origCount: 1 },
    ]);
  });
});
